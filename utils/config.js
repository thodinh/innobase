var fs = require("fs");
var cp = require("child_process");
var dns = require("dns");
var os = require('os');

var Args = require("./args");
var Tools = require("./tools");
var BaseEvent = require("../base/base-event");

module.exports = class Config extends BaseEvent {

	constructor(thingy, watch, isa_sub) {
		super();
		this.configFile = "";
		this.config = null;
		this.args = null;
		this.subs = null;
		this.mod = 0;
		this.timer = null;
		this.freq = 10 * 1000;
		this.hostname = '';
		this.ip = '';

		// class constructor
		this.subs = {};

		if (thingy) {
			if (typeof (thingy) == 'string') this.configFile = thingy;
			else {
				this.config = thingy;
				this.configFile = "";
			}
		}
		else return; // manual setup

		if (!isa_sub) {
			this.args = new Args();
		}

		if (this.configFile) this.load();
		else if (!isa_sub) this.loadArgs();

		if (this.configFile && watch && !isa_sub) {
			if (typeof (watch) == 'number') this.freq = watch;
			if (this.config.check_config_freq_ms) this.freq = this.config.check_config_freq_ms;
			this.monitor();
		}
	}

	parse(text) {
		// default JSON parser (client can override)
		return JSON.parse(text);
	}

	load() {
		// load config and merge in cmdline
		var self = this;
		this.config = {};

		var stats = fs.statSync(this.configFile);
		this.mod = (stats && stats.mtime) ? stats.mtime.getTime() : 0;

		var config = this.parse(
			fs.readFileSync(this.configFile, { encoding: 'utf8' })
		);
		for (var key in config) {
			this.config[key] = config[key];
		}

		// cmdline args (--key value)
		this.loadArgs();
	}

	loadArgs() {
		// merge in cmdline args (--key value)
		if (!this.args) return;

		for (var key in this.args.get()) {
			this.setPath(key, this.args.get(key));
		}
	}

	monitor() {
		// start monitoring file for changes
		this.timer = setInterval(this.check.bind(this), this.freq);
	}

	stop() {
		// stop monitoring file
		clearTimeout(this.timer);
	}

	check() {
		// check file for changes, reload if necessary
		var self = this;

		fs.stat(this.configFile, function (err, stats) {
			// ignore errors here due to possible race conditions
			var mod = (stats && stats.mtime) ? stats.mtime.getTime() : 0;

			if (mod && (mod != self.mod)) {
				// file has changed on disk, reload it async
				self.mod = mod;

				fs.readFile(self.configFile, { encoding: 'utf8' }, function (err, data) {
					// fs read complete
					if (err) {
						self.emit('error', "Failed to reload config file: " + self.configFile + ": " + err);
						return;
					}

					// now parse the JSON
					var config = null;
					try {
						config = self.parse(data);
					}
					catch (err) {
						self.emit('error', "Failed to parse config file: " + self.configFile + ": " + err);
						return;
					}

					// replace master copy
					self.config = config;

					// re-merge in cli args
					if (self.args) {
						for (var key in self.args.get()) {
							self.setPath(key, self.args.get(key));
						}
					}

					// emit event for listeners
					self.emit('reload');

					// refresh subs
					self.refreshSubs();

					// reinitialize monitor if frequency has changed
					if (self.timer && config.check_config_freq_ms && (config.check_config_freq_ms != self.freq)) {
						self.freq = config.check_config_freq_ms;
						self.stop();
						self.monitor();
					}

				}); // fs.readFile
			} // mod changed
		}); // fs.stat
	}

	get(key) {
		// get single key or entire config hash
		return key ? this.config[key] : this.config;
	}

	set(key, value) {
		// set config value
		this.config[key] = value;

		// also set it in this.args so a file reload won't clobber it
		if (this.args) this.args.set(key, value);
	}

	import(hash) {
		// import all keys/values from specified hash (shallow copy)
		Tools.mergeHashInto(this.config, hash);
	}

	getSub(key) {
		// get cloned Config object pointed at sub-key
		var sub = new Config(this.get(key) || {}, null, true);

		// keep track so we can refresh on reload
		this.subs[key] = sub;

		return sub;
	}

	refreshSubs() {
		// refresh sub key objects on a reload
		for (var key in this.subs) {
			var sub = this.subs[key];
			sub.config = this.get(key) || {};
			sub.emit('reload');
			sub.refreshSubs();
		}
	}

	getEnv(callback) {
		// determine environment (hostname and ip) async
		var self = this;

		// get hostname and ip (async ops)
		self.getHostname(function (err) {
			if (err) callback(err);
			else {
				self.getIPAddress(callback);
			}
		});
	}

	getHostname(callback) {
		if (this.config.bind_hostname) {
			this.hostname = this.config.bind_hostname;
			callback();
			return;
		}
		// determine server hostname
		this.hostname = (process.env['HOSTNAME'] || process.env['HOST'] || '').toLowerCase();
		if (this.hostname) {
			// well that was easy
			callback();
			return;
		}

		// try the OS module
		this.hostname = os.hostname().toLowerCase();
		if (this.hostname) {
			// well that was easy
			callback();
			return;
		}

		// sigh, the hard way (exec hostname binary)
		var self = this;
		child = cp.execFile('/bin/hostname', function (error, stdout, stderr) {
			self.hostname = stdout.toString().trim().toLowerCase();
			if (!self.hostname) {
				callback(new Error("Failed to determine server hostname via /bin/hostname"));
			}
			else callback();
		});
	}

	getIPAddress(callback) {
		// determine server ip address
		var self = this;
		if (this.config.bind_ip) {
			this.ip = this.config.bind_ip;
			callback();
			return;
		}

		// try OS networkInterfaces() first
		// find the first external IPv4 address that doesn't match 169.254.
		var ifaces = os.networkInterfaces();
		var addrs = [];
		for (var key in ifaces) {
			if (ifaces[key] && ifaces[key].length) {
				Array.from(ifaces[key]).forEach(function (item) { addrs.push(item); });
			}
		}

		var iaddrs = Tools.findObjects(addrs, { family: 'IPv4', internal: false });
		for (var idx = 0, len = iaddrs.length; idx < len; idx++) {
			var addr = iaddrs[idx];
			if (addr && addr.address && addr.address.match(/^\d+\.\d+\.\d+\.\d+$/) && !addr.address.match(/^169\.254\./)) {
				if (!this.config.bind_network || Tools.test_in_subnet(addr.address, this.config.bind_network)) {
					// well that was easy
					this.ip = addr.address;
					callback();
					return;
				}
			}
		}

		var addr = iaddrs[0];
		if (addr && addr.address && addr.address.match(/^\d+\.\d+\.\d+\.\d+$/)) {
			// this will allow 169.254. to be chosen only after all other non-internal IPv4s are considered
			this.ip = addr.address;
			callback();
			return;
		}

		// sigh, the hard way (DNS resolve the server hostname)
		dns.resolve4(this.hostname, function (err, addresses) {
			// if (err) callback(err);
			self.ip = addresses ? addresses[0] : '127.0.0.1';
			callback();
		});
	}

	setPath(path, value) {
		// set path using dir/slash/syntax or dot.path.syntax
		// preserve dots and slashes if escaped
		var parts = path.replace(/\\\./g, '__PXDOT__').replace(/\\\//g, '__PXSLASH__').split(/[\.\/]/).map(function (elem) {
			return elem.replace(/__PXDOT__/g, '.').replace(/__PXSLASH__/g, '/');
		});

		var key = parts.pop();
		var target = this.config;

		// traverse path
		while (parts.length) {
			var part = parts.shift();
			if (part) {
				if (!(part in target)) {
					// auto-create nodes
					target[part] = {};
				}
				if (typeof (target[part]) != 'object') {
					// path runs into non-object
					return false;
				}
				target = target[part];
			}
		}

		target[key] = value;
		return true;
	}

	getPath(path) {
		// get path using dir/slash/syntax or dot.path.syntax
		// preserve dots and slashes if escaped
		var parts = path.replace(/\\\./g, '__PXDOT__').replace(/\\\//g, '__PXSLASH__').split(/[\.\/]/).map(function (elem) {
			return elem.replace(/__PXDOT__/g, '.').replace(/__PXSLASH__/g, '/');
		});

		var key = parts.pop();
		var target = this.config;

		// traverse path
		while (parts.length) {
			var part = parts.shift();
			if (part) {
				if (typeof (target[part]) != 'object') {
					// path runs into non-object
					return undefined;
				}
				target = target[part];
			}
		}

		return target[key];
	}

}