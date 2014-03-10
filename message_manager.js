var DB_CONFIG = require('config').connections;
var MongoClient = require('mongodb').MongoClient;
var _ = require('underscore');
var getLogger = require('./logger').getLogger;
var getError = require('./exceptions').getError;
var async = require('async');

var STATE = {
	READY: "READY",
	PROCESSING: "PROCESSING",
	DONE: "DONE",
	RETRY: "RETRY",
	FAIL: "FAIL"
};

var REQUEST_RESULT = {
	SUCCESS: "SUCCESS",
	FAIL: "FAIL"
};

function MessageManager() {
	// sample data
	// eventSubscribers = {
	// 	"event1": [{
	// 		subscriberId: "id1",
	// 		socket: socket1
	// 	}, {
	// 		subscriberId: "id2",
	// 		socket: socket2
	// 	}, ...],
	// 	"event2": []
	// 		...
	// };
	this.logger = getLogger("MainLoop");
	this.eventSubscribers = {};
}

MessageManager.prototype = {
	// @return {status: <[true, false]>, error: (optional)}
	validate: function(data) {
		var result = {
			requestId: data.requestId,
			status: REQUEST_RESULT.SUCCESS
		};
		// 数据合法性检查
		if (!data.event) {
			result.error = getError("ArgumentError", "event");
			result.status = REQUEST_RESULT.FAIL;
		}

		if (!data.senderId) {
			result.error = getError("ArgumentError", "senderId");
			result.status = REQUEST_RESULT.FAIL;
		}

		return result;
	},
	listen: function(port, host) {
		var that = this;

		MongoClient.connect(DB_CONFIG.url, function(err, db) {
			if (err) {
				var error = getError("DatabaseUnavailable");
				this.logger.fatal("无数连接到数据库。", error);
				return;
			}

			that.db = db;
			var server = http.createServer(port, host ? host : "0.0.0.0");
			this.io = require('socket.io').listen(server);
			this.io.sockets.on('connection', function(socket) {
				// 订阅事件
				socket.on("subscribe", function(data, callback) {
					that.subscribe(socket, data, callback);
				});

				// 增加事件到队列
				socket.on("enqueue", function(data, callback) {
					that.enqueue(socket, data, callback);
				});
			});

			// 每分钟尝试分发事件
			setInterval(function() {
				that.dispatch();
			}, 600000);
		});
	},
	// request data sample
	// data = {
	// 	"requestId": "",	// mandatory. unique ID of each request.
	// 	"senderId": "",	// mandatory. unique name of sender.
	// 	"event": "enqueue", // mandatory. options: enqueue/ack/command.
	// 	"params": {},	// optional. only available when action=command
	// }
	subscribe: function(socket, data, callback) {
		var result = this.validate(data);
		if (result.status == REQUEST_RESULT.FAIL) {
			this.acknowledge(callback, result);
			return;
		}

		if (!this.eventSubscribers[data.event]) {
			this.eventSubscribers[data.event] = [];
		}

		var subscribers = this.eventSubscribers[data.event];
		// check if this client has subscribed before
		var existed = _.find(subscribers, function(subscriber) {
			return subscriber.senderId = data.senderId;
		});

		if (existed) {
			// client already subscribed. close previous connection, use current one instead.
			var existedSocket = existed.socket;
			existed.socket = socket;
			if (existedSocket.connected) {
				existedSocket.disconnect();
				this.logger.warn("客户端和服务端已经存在连接。", getError("AlreadyConnected", senderId));
			}
		} else {
			subscribers.push({
				subscriberId: data.senderId,
				socket: socket
			});
		}
		this.acknowledge(callback, {
			reqeustId: data.requestId,
			status: REQUEST_RESULT.SUCCESS
		});
	},
	unsubscribe: function(event, subscriberId) {
		var subscribers = this.eventSubscribers[event];
		if (subscribers[subscriberId] && subscribers[subscriberId].socket.connected) {
			subscribers[subscriberId].socket.disconnect();
		}
		delete subscribers[subscriberId];
		this.logger.info(util.format("已退订[%s]", subscriberId));
	},
	// request sample
	// data = {
	// 	"requestId": "",	// mandatory. unique ID of each request.
	// 	"senderId": "",	// mandatory. unique name of sender.
	// 	"event": "enqueue", // mandatory. options: enqueue/ack/command.
	//  "retryLimit": 1 	// optional. defaults to 0. -1 = always.
	// 	"args": {},	// optional. only available when action=command
	// }
	enqueue: function(data, callback) {
		// 数据示例
		// {
		// 	"_id": "",	// mandatory. 
		// 	"requestId": "",	// mandatory. unique ID of each request.
		// 	"senderId": "",	// mandatory. unique name of sender.
		// 	"event": "",	// mandatory. event name.
		// 	"retryLimit": 1,	// mandatory. how many times should we retry if fails. -1 = always.
		// 	"timeout": 60,	// mandatory. timeout in seconds.
		// 	"args": {},	// optional.
		// 	"subscribers": [{
		// 		subscriberId: "id1",
		// 		remainingRetryTimes: 4,
		// 		state: STATE.READY,
		// 		lastOperateTime: new Date()
		// 	}] // target names
		// }
		var result = this.validate(data);
		if (result.status == REQUEST_RESULT.FAIL) {
			this.acknowledge(callback, result);
			return;
		}

		var that = this;
		// check how many subscribers are there.
		var subscribers = _.map(this.eventSubscribers[data.event], function(elm) {
			return {
				subscriberId: elm.senderId,
				remainingRetryTimes: data.retryLimit,
				state: STATE.READY,
				lastOperateTime: null
			}
		});
		this.db.collection("queue").insert({
			"requestId": data.requestId,
			"senderId": data.senderId,
			"retryLimit": data.retryLimit,
			"timeout": data.timeout,
			"event": data.event,
			"args": data.args,
			"createAt": new Date(),
			"state": STATE.READY,
			"subscribers": subscribers
		}, function(err, doc) {
			if (err) {
				that.logger.fatal("无法将新请求添加到数据库。", err);
				that.acknowledge(callback, "fail", err);
			}

			that.acknowledge("success");
			that.dispatch();
		});
	},
	acknowledge: function(callback, data) {
		var result = {
			requestId: data.requestId,
			status: data.status
		};
		if (data.error) {
			result.error = {
				name: data.error.name,
				message: data.error.message,
				stack: data.error.stack
			}
		}

		callback(result);
	},
	dispatch: function() {
		var that = this;

		// find the earliest event with status READY or RETRY.
		// only one record is proceeded at one time.
		this.db.collection("queue").findAndModify({
			"$or": [{
				state: STATE.READY
			}, {
				state: STATE.RETRY
			}]
		}, {
			createAt: 1
		}, {
			"$set": {
				state: STATE.PROCESSING
			}
		}, {

		}, function(err, record) {
			if (err) {
				this.logger.fatal("无法更新请求状态READY/RETRY->PROCESSING。", err);
				return;
			}

			if (record) {
				// send another event to process more record.
				setTimeout(this.dispatch.bind(this), 10);
			} else {
				// no more record to process.
				return;
			}

			var event = record.event;
			var subscribers = record.subscribers;
			// looking up ready subscribers
			var readySubscribers = [];
			_.each(subscribers, function(s) {
				// TODO: control the retry time.
				if ((s.remainingRetryTimes > 0 || s.remainingRetryTimes == -1) && (s.state == STATE.READY || s.state == STATE.RETRY) && (s.lastOperateTime == null || (new Date() - s.lastOperateTime) > 60000)) {
					readySubscribers.push(s);
					s.remainingRetryTimes -= s.remainingRetryTimes > 0 ? 1 : 0;
					s.state = STATE.PROCESSING;
					s.lastOperateTime = new Date();
				}
			});

			// batch update all the subscriber status in current record to PROCESSING
			this.db.collection("queue").update({
				"_id": record["_id"]
			}, record, function(err) {
				if (err) {
					// unable to update subscriber state from READY/RETRY to PROCESSING 
					this.logger.fatal("无法更新subscribers的请求状态READY/RETRY->PROCESSING", err);
					// TODO: try to revert record state from PROCESSING back to READY/RETRY
					return;
				}

				var subscriberSockets = _.indexBy(this.eventSubscribers[event], 'subscriberId');
				// database updated, notify clients.
				// process all clients in parallel.
				async.map(readySubscribers, (function(subscriber, callback) {
					// TODO: what if socket doesn't exist?
					var socket = subscriberSockets[subscriber.subscriberId].socket;
					// if request doesn't return in time, treat as a failure.
					var timeoutHandler = setTimeout(function() {
						that.unsubscribe(event, subscriber.subscriberId);
						callback(null, {
							subscriberId: subscriber.subscriberId,
							status: REQUEST_RESULT.FAIL
						})
					}, record.timeout);
					socket.emit(event, doc.args, function(data) {
						// cancel the failure notification because it's succeeded.
						clearTimeout(timeoutHandler);
						// notify parallel result
						callback(null, {
							subscriberId: subscriber.subscriberId,
							status: data.status
						});
					});
				}).bind(that), function(err, results) {
					// parallel finished. update subscriber state.
					_.each(subscribers, function(s) {
						var subscriberStatus = _.find(results, function(status) {
							return status.subscriberId == s.subscriberId;
						});
						if (subscriberStatus) {
							switch (subscriberStatus.status) {
								case REQUEST_RESULT.SUCCESS:
									s.state = STATE.DONE;
									break;
								case REQUEST_RESULT.FAIL:
									s.state = s.remainingRetryTimes == 0 ? STATE.FAIL : STATE.RETRY;
									break;
							}
						}
					})

					var states = _.countBy(subscribers, function(s) {
						return s.state;
					});

					// normally there should be only RETRY/DONE/FAIL.
					// in rare situations there could be other states.
					var done = states[STATE.DONE];
					var retry = states[STATE.RETRY];
					var fail = states[STATE.FAIL];
					var ready = states[STATE.READY];
					var processing = states[STATE.PROCESSING];
					if (done && !retry && !fail && !ready && !processing) {
						// all done
						record.state = STATE.DONE;
					} else if (!retry && !ready && !processing) {
						// nothing else than DONE/FAIL. all DONE is filtered out so FAIL.
						record.state = STATE.FAIL;
					} else {
						// retriable
						record.state = STATE.RETRY;
					}

					this.db.collection("queue").update({
						"_id": record["_id"]
					}, record, function(err) {
						if (err) {
							// unable to update subscriber state from READY/RETRY to PROCESSING 
							this.logger.fatal("Cannot finalize states.\n" + JSON.stringify(record), err);
							return;
						}
					});
				});
			});
		});
	}
};