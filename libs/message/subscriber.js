var DB_CONFIG = require('../../config/default').connections;
var MongoClient = require('mongodb').MongoClient;
var _ = require('underscore');
var getLogger = require('../log/logger').getLogger;
var getError = require('../exception/exceptions').getError;
var async = require('async');
var util = require("util");
var STATE = require("./base").STATE;
var REQUEST_RESULT = require("./base").REQUEST_RESULT;

var SUBSCRIBER_STATE = {
	ALIVE: "ALIVE",
	DEAD: "DEAD"
}

function Subscriber(manager, config) {
	// sample data
	// config = {
	// 	id: "",
	// 	socket: socket,
	// 	event: "",
	// 	timeout: 60
	// }
	this.state = SUBSCRIBER_STATE.ALIVE;
	this.id = config.id;
	this.socket = config.socket;
	this.event = config.event;
	this.manager = manager;
	this.logger = getLogger("Subscriber");
}

Subscriber.prototype = {
	notify: function(args, timeout, asyncCallback) {
		// Handle unexpected errors. Including timeout, error.
		var errorHandling = function() {
			this.manager.unsubscribe(this);
			asyncCallback(null, {
				subscriberId: this.id,
				status: REQUEST_RESULT.FAIL
			});
		};
		// if request doesn't return in time, treat as a failure.
		var timeoutHandler = setTimeout(errorHandling.bind(this), timeout);
		try {
			this.socket.emit(this.event, args, function(data) {
				// cancel the failure notification because it's succeeded.
				clearTimeout(timeoutHandler);
				// notify parallel result
				asyncCallback(null, {
					subscriberId: this.id,
					status: data.status
				});
			}.bind(this));
		} catch (err) {
			// don't need to do anything because it's going to trigger timeout.
			this.logger.error("Unable to emit event to subscriber.", err);
		}
	},
	dispose: function() {
		if (this.socket.connected) {
			this.socket.disconnect();
		}
		this.state = SUBSCRIBER_STATE.DEAD;
		this.logger.info("Subscriber [" + this.id + "] disposed.")
	}
}

exports.Subscriber = Subscriber;
exports.SUBSCRIBER_STATE = SUBSCRIBER_STATE;