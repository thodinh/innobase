var MainClass = require('./base/generic-class');

var mainClass = new MainClass({

    __name: 'MainClass',
    __version: require('./package.json').version,

    configFile: require('path').join("conf/config.json"),

    components: [ ]

});

mainClass.startup(function () {

});