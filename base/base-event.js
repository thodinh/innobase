var EventEmitter = require("events").EventEmitter;
var Base = require("./base");
var inherit = require("../utils/mixins");
module.exports = class BaseEmitter extends inherit(Base, EventEmitter) {
  constructor(...args) {
    super(...args);
  }
};
