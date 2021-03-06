var DB_CONFIG = require('../../config/default').connections;
var MongoClient = require('mongodb').MongoClient;
var _ = require('underscore');
var getLogger = require('../log/logger').getLogger;
var getError = require('../exception/exceptions').getError;
var util = require("util");
var dbBase = require("./base").dbBase;
var STATE = require("./base").STATE;
var REQUEST_RESULT = require("./base").REQUEST_RESULT;
var COLLECTION_NAME = require('../../config/default').queueCollectionName;

// find the earliest event with status READY or RETRY.
// only one record is proceeded at one time.
function Event(db, record, subscribers) {
	this.db = db;
	this.originalRecord = record;
	this.logger = getLogger("EventTrigger");

	// looking up ready subscribers
	var readySubscriberIds = [];
	_.each(record.subscribers, function(s) {
		// TODO: control the retry time.
		if ((s.remainingTryTimes > 0 || s.remainingTryTimes == -1) && (s.state == STATE.READY || s.state == STATE.RETRY) && (s.lastOperateTime == null || (new Date() - s.lastOperateTime) > 60000)) {
			readySubscriberIds.push(s.subscriberId);
			s.remainingTryTimes -= s.remainingTryTimes > 0 ? 1 : 0;
			s.state = STATE.PROCESSING;
			s.lastOperateTime = new Date();
		}
	});

	// get subscribers to be notified
	this.subscribers = _.filter(subscribers, function(s) {
		return _.contains(readySubscriberIds, s.id);
	});
}

Event.prototype = {
	_updateSubscriber: function(result) {
		var subscriberToBeUpdated = _.find(this.originalRecord.subscribers, function(s) {
			return s.subscriberId == result.subscriberId;
		});
		switch (result.status) {
			case REQUEST_RESULT.SUCCESS:
				subscriberToBeUpdated.state = STATE.DONE;
				break;
			default:
			case REQUEST_RESULT.FAIL:
				subscriberToBeUpdated.state = subscriberToBeUpdated.remainingTryTimes == 0 ? STATE.FAIL : STATE.RETRY;
				break;
		}
		this._getCollection().update({
			"_id": this.originalRecord["_id"],
			subscribers: {
				"$elemMatch": {
					subscriberId: result.subscriberId
				}
			}
		}, {
			"$set": {
				"subscribers.$": subscriberToBeUpdated
			}
		}, function(err) {
			if (err) {
				this.logger.error("Failed to update subscriber state: PROCESSING->" + subscriberToBeUpdated.state + "\n" + JSON.stringify(subscriberToBeUpdated),
					getError("DatabaseUnavailable"));
			}
		}.bind(this));
	},
	dispatch: function() {
		// batch update all the subscriber status in current record to PROCESSING
		this._getCollection().update({
			"_id": this.originalRecord["_id"]
		}, this.originalRecord, function(err) {
			if (err) {
				// unable to update subscriber state from READY/RETRY to PROCESSING 
				this.logger.fatal("Failed to update subscribers state: READY/RETRY->PROCESSING", err);
				// TODO: try to revert record state from PROCESSING back to READY/RETRY
				return;
			}

			var finalizeDatabase = function() {
				this._getCollection().update({
					"_id": this.originalRecord["_id"]
				}, {
					"$set": {
						state: this.originalRecord.state
					}
				}, function(err) {
					if (err) {
						this.logger.error("Failed to update record state PROCESSING->" + STATE.DONE + "\n" + this.originalRecord["_id"],
							getError("DatabaseUnavailable"));
					}
				}.bind(this));
			}.bind(this);
			var updated = 0;
			if (this.subscribers.length == 0) {
				this.originalRecord.state = STATE.DONE;
				finalizeDatabase();
				return;
			} else {
				_.each(this.subscribers, function(subscriber) {
					subscriber.notify(this.originalRecord.args, this.originalRecord.timeout, function(result) {
						this._updateSubscriber(result);
						if (++updated == this.subscribers.length) {
							var states = _.countBy(this.originalRecord.subscribers, function(s) {
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
								this.originalRecord.state = STATE.DONE;
							} else if (!retry && !ready && !processing) {
								// nothing else than DONE/FAIL. all DONE is filtered out so FAIL.
								this.originalRecord.state = STATE.FAIL;
							} else {
								// retriable
								this.originalRecord.state = STATE.RETRY;
							}
							finalizeDatabase();
						}
					}.bind(this));
				}.bind(this));
			}
		}.bind(this));
	}
};

Event.createInstance = function(db, eventSubscribers, callback) {
	var logger = getLogger("EventTrigger");
	db.collection(COLLECTION_NAME).findAndModify({
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
		new: true
	}, function(err, record) {
		if (err) {
			logger.fatal("Cannot update request state: READY/RETRY->PROCESSING.", err);
			return;
		}

		if (record) {
			var subscribers = eventSubscribers[record.event];
			callback(new Event(db, record, subscribers));
		} else {
			callback(null);
		}
	});
};

_.extend(Event.prototype, dbBase);

exports.Event = Event;