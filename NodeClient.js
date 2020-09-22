/**
 * NodeClient.js v1.0.6
 */

const { exec } = require('child_process');
const fs = require("fs");
const path = require("path");
const uuidv4 = require('uuid/v4');

let configFilePath = process.cwd()+'/config.json';
let config = {};
if(fs.existsSync(configFilePath)) {
    config = require(process.cwd()+'/config.json');
}

const ss = require('socket.io-stream');
const pjson = require(process.cwd() + '/package.json');
const Tail = require('tail-file');

function checkAllowedSender(nodeFrom) {
    return true;
}

function checkAllowedMessage(message) {
    return true;
}

function procesMessage(Handler, msg, ack) {
    let fn = NodeClient.commonHandler[msg.method];
    if (typeof Handler !== 'undefined' && typeof fn === "undefined") {
        console.log(`index = ${msg.method.indexOf('.')}`);
        if(msg.method.indexOf('.')>0) {
            let arr = msg.method.split(".");
            fn = Handler[arr[0]][arr[1]];
        } else {
            fn = Handler[msg.method];
        }
    }
    if (typeof fn === "function") {
        console.debug(`Executing function ${msg.method}`);
        const isAsync = fn.constructor.name === "AsyncFunction";
        console.log('isAsync',isAsync);
        let res;
        if(isAsync) {
            new Promise(async function(resolve, reject) {
                try {
                    resolve(await fn(msg));
                } catch (e) {
                    reject({error:true, message:e.message});
                }
            }).then((fnRes) => {
                res = fnRes;

            }).catch((err) => {
                res = err;
            }).finally(() => {
                if (typeof ack === 'function') {
                    ack(res);
                }
            });
        } else {
            try {
                res = fn(msg);
            } catch (e) {
                res = {error:true, message:e.message};
            }
            if (typeof ack === 'function') {
                ack(res);
            }
        }
    } else {
        console.warn(`Not found function ${msg.method}`);
    }
}

function procesStreamMessage(Handler, stream, data) {
    let fn = NodeClient.commonHandler[data.method];
    if (typeof Handler !== 'undefined' && typeof fn === "undefined") {
        fn = Handler[data.method];
    }
    if (typeof fn === "function") {
        fn(stream, data);
    } else {
        console.warn(`Not found function for stream ${data.method}`);
    }
}

const NodeClient = {

    SOCKET_SECRET: 'netsock',
    socket : null,
    deviceId: null,
    handler: null,
    modules: [],
    methods: {},
    streamRegistry: {},

    start() {
        NodeClient.init();
        NodeClient.connect();
        NodeClient.handle();
        NodeClient.loadModules();
    },

    init() {
        let deviceJsonFile = process.cwd() + "/device.json";
        let deviceJson = {};
        if (!fs.existsSync(deviceJsonFile)) {
            console.log("Device file not exists - creating");
            deviceJson = {
                deviceId: uuidv4()
            };
            fs.writeFileSync(deviceJsonFile, JSON.stringify(deviceJson));
        }
        deviceJson = require(deviceJsonFile);
        let deviceId = deviceJson.deviceId;

        let hookFn = NodeClient.hooks && NodeClient.hooks.modifyDeviceId;
        if(typeof hookFn === 'function') {
            deviceId = hookFn(deviceId);
        }
        NodeClient.deviceId = deviceId;
        console.debug(`Initialized node client for device ${deviceId}`)
    },

    connect(url= null, secret=null) {
        if(!url) {
            url = config.connect_url;
        }
        if(!secret) {
            secret = config.connect_secret;
        }
        let query = {
            secret: secret,
            deviceId: NodeClient.deviceId,
            processId: process.pid,
            modules: config.modules || [],
            version: pjson.version
        }
        this.socket = require('socket.io-client')(url, {
            query: query
        });
        console.debug(`Connecting to remote socket ${url}`)
    },

    handle(Handler=null) {
        if(!this.handler) {
            this.handler = Handler;
        }

        let socket = this.socket;

        socket.on("requestDeviceMethod", (method, params, ack) => {
            //console.log(`Requested method ${method} params=${JSON.stringify(params)}`);
            let fn = this.commonHandler[method];
            if(!fn) {
                fn = this.handler && this.handler[method];
            }
            if(!fn) {
                fn = this.methods[method];
            }
            if(!fn) {
                fn = global[method];
            }
            if(typeof fn !== 'function') {
                console.log(`Method ${method} not found`);
                if(typeof ack === 'function') {
                    ack({error:{message:`Method ${method} not found`,status:'DEVICE_METHOD_NOT_FOUND',stack:Error().stack}});
                }
                return;
            }
            const isAsync = fn.constructor.name === "AsyncFunction";
            if(isAsync) {
                new Promise(async function(resolve, reject) {
                    let res;
                    try {
                        if(typeof params === "object" && params.length>0) {
                            res = await fn(...params);
                        } else {
                            res = await fn(params);
                        }
                    } catch(e) {
                        res = {error:{message:e.message, stack:e.stack, code:'DEVICE_METHOD_ERROR'}};
                    }
                    if (typeof ack === 'function') {
                        resolve(ack(res));
                    } else  {
                        resolve(res);
                    }
                });
            } else {
                let res;
                try {
                    if(typeof params === "object" && params.length>0) {
                        res = fn(...params);
                    } else {
                        res = fn(params);
                    }
                } catch(e) {
                    res = {error:{message:e.message, stack:e.stack, code:'DEVICE_METHOD_ERROR'}};
                }
                if(typeof ack === 'function') {
                    ack(res);
                }
            }
        });

        ss(socket).on('requestDeviceStream',  (stream, data, ack) => {
            try {
                console.log(`Received requestDeviceStream ${data.method}`);
                let method = data.method;
                let params = data.params;
                let fn = this.commonHandler[method];
                if(!fn) {
                    fn = this.handler && this.handler[method];
                }
                if(!fn) {
                    fn = this.methods[method];
                }
                if(!fn) {
                    fn = global[method];
                }
                if(typeof fn !== 'function') {
                    console.log(`Method ${method} not found`);
                    ack();
                    return;
                }
                ack(fn(stream, params, ack));
            } catch(e) {
                let res = {error:{message:e.message, stack:e.stack, code:'DEVICE_METHOD_ERROR'}};
                ack(res);
            }

        });






        this.socket.on('message1', function(msg, ack){
            console.log(msg);
            //check message
            let nodeTo = msg.to;
            if(nodeTo !== NodeClient.deviceId) {
                console.error(`Received message not for this node`);
                return;
            }
            let nodeFrom = msg.from;
            if(!checkAllowedSender(nodeFrom)) {
                console.error(`Not allowed sending from node ${nodeFrom}`);
                if (typeof ack === 'function') {
                    ack({error: true, message: `Not allowed sending from node ${nodeFrom}`});
                }
                return;
            }
            if(!checkAllowedMessage(msg.method)) {
                console.error(`Not allowed message with name ${msg.method}`);
                if (typeof ack === 'function') {
                    ack({error: true, message: `Not allowed message with name ${msg.method}`});
                }
                return;
            }
            procesMessage(Handler, msg, ack);
        });
        this.socket.on('disconnect', function(reason){
            console.log("disconnected socket");
        });
        ss(this.socket).on('streamMessage1', function(stream, data) {
            procesStreamMessage(Handler, stream, data);
        });
    },

    loadModules() {
        for(let i in config.modules) {
            let moduleName = config.modules[i];
            let moduleFile = `${process.cwd()}/app/modules/${moduleName}/index.js`
            let module
            console.debug(`Loading module ${moduleName}`)
            if(fs.existsSync(moduleFile)) {
                module = require(moduleFile);
            } else {
                module = require(`nclient-module-${moduleName}`);
            }
            NodeClient.modules.push(module)
        }
    },

    loadUtils() {
        let utilFolder = path.join(process.cwd(),'app','utils')
        if(fs.existsSync(utilFolder)) {
            fs.readdir(utilFolder, (err, files) => {
                files.forEach(file => {
                    file = path.join(utilFolder, file)
                    require(file);
                })
            })
        }
    },

    async asyncEmit(event, params) {
        return new Promise((resolve, reject) => {
            if(!this.socket.connected) {
                resolve({error:{message:'Remote server not connected',status:'MEDIATOR_NOT_CONNECTED',stack:Error().stack}});
            } else {
                this.socket.emit(event,params,(res) => {
                    resolve(res);
                })
            }
        })
    },

    emit(event, ...params){
        let cb;
        if(typeof params[params.length-1] === 'function') {
            cb = params.pop();
            if(!this.socket.connected) {
                cb({error:{message:'Remote server not connected',status:'MEDIATOR_NOT_CONNECTED',stack:Error().stack}});
            } else {
                let cbe = (res) => {
                    cb(res);
                };
                params = [...params, cbe];
                this.socket.emit(event,...params);
            }
        } else {
            this.socket.emit(event,...params);
        }
    },

    requestDeviceMethod(deviceId, method, ...params) {
        let cb = params.pop();
        let cbe = (res) => {
            if(typeof cb === 'function') {
                cb(res);
            }
        };
        if(params.length===1) {
            params = params[0];
        }
        this.emit("requestDeviceMethod",{from: global.deviceId, to: deviceId, method: method, params: params}, cbe);
    },

    async asyncRequestDeviceMethod(deviceId, method, params) {
        let res =  await this.asyncEmit("requestDeviceMethod",{from: global.deviceId, to: deviceId, method: method, params: params});
        return res;
    },






    //----------------------------------------------------------------
    sendRequest(message, callback) {
        message = message || {};
        if(!message.method) {
            return;
        }
        if(!message.from) {
            message.from = NodeClient.deviceId;
        }
        if(!message.payload) {
            message.payload = {};
        }
        //console.log('Sending message', message);
        this.emit("requestDeviceMethod", {to: message.to, from: message.from, method: message.method, params: message.payload},callback);

        // this.socket.emit("message", message, callback ? function(ack){
        //     callback(ack);
        // } : null);
    },

    sendStreamRequest(stream, method, deviceId, params, ack) {
        let fccStream = ss.createStream({objectMode:true});
        fccStream.pipe(stream);
        stream.on('end', function() {
            fccStream.end()
        });
        stream.on('close', function() {
            fccStream.end()
        });
        stream.on('unpipe', function() {
            fccStream.end()
        });
        ss(this.socket).emit('requestDeviceStream', fccStream, {from: NodeClient.deviceId, to:deviceId, method:method, params: params }, (res)=>{
            ack(res);
        });
    },

    storeData(name, property, value) {
        NodeClient.sendRequest({method: 'storeData', payload:{name, property, value}})
    },

    readData(name, property, filter, cb) {
        NodeClient.sendRequest({method:'readData', payload: {name, property, filter}}, cb)
    },

    execSQL(sql, params, cb) {
        NodeClient.sendRequest({method: 'execSQL', payload: {sql, params}}, cb);
    },

    registerDeviceMethod(method, fn) {
        this.methods[method]=fn
    },

    registerDeviceStreamMethod(method, onStart, onEnd) {
        let fn = (stream, params, ack) => {
            let fnStream = new require('stream').Readable({
                read() {},
                objectMode: true
            })
            fnStream.pipe(stream)
            if(!this.streamRegistry[method]) {
                this.streamRegistry[method] = {}
            }
            this.streamRegistry[method][stream.id]=fnStream
            stream.on('unpipe',()=>{
                onEnd(fnStream)
                delete this.streamRegistry[method][stream.id]
                fnStream.destroy()
            });
            return onStart(fnStream, params)
        }
        this.methods[method]=fn
    },

    updateDeviceStreamMethod(method, fn) {
        let streams = this.streamRegistry[method]
        for(let stream in streams) {
            fn(stream)
        }
    },

    readModuleInfo(mpjson) {
        return {
            version: mpjson.version,
            id: mpjson.id,
            name: mpjson.title,
            description: mpjson.description
        };
    },

    readConfig(moduleId, file, create) {
        let configFile = path.join(process.cwd(),'app','configs',moduleId, file)
        if(fs.existsSync(configFile)) {
            let content = fs.readFileSync(configFile)
            return JSON.parse(content)
        } else {
            if(create) {
                let folder = path.join(process.cwd(),'app','configs',moduleId)
                fs.mkdirSync(folder, { recursive: true} )
                fs.writeFileSync(configFile, JSON.stringify({}))
            }
            return {}
        }
    },

    storeConfig(moduleId, file, content) {
        let configFile = path.join(process.cwd(),'app','configs',moduleId, file)
        fs.writeFileSync(configFile, content)
    },

    storeSocketData(key, value) {
        console.log(`Send storeSocketData ${key}=${value}`)
        this.sendRequest({method: 'storeSocketData', payload: { key, value, from: NodeClient.deviceId }})
    },

    commonHandler: {
        async execCmd(cmd) {

            let hookFn = NodeClient.hooks && NodeClient.hooks.beforeExecCmd;
            if(typeof hookFn === 'function') {
                cmd = hookFn(cmd);
            }

            console.log(`Executin shell command: ${cmd}`);
            return new Promise(function(resolve, reject) {
                exec(cmd, (err, stdout, stderr) => {
                    if (err) {
                        // node couldn't execute the command
                        console.log(err);
                        //reject(err);
                    }
                    resolve({
                        stdout:stdout,
                        stderr:stderr
                    });
                });
            });
        },
        restart() {
            setTimeout(function () {
                process.on("exit", function () {
                    require("child_process").spawn(process.argv.shift(), process.argv, {
                        cwd: process.cwd(),
                        detached : true,
                        stdio: "inherit"
                    });
                });
                process.exit();
            }, 1000);
        },
        stop() {
            process.exit();
        },
        getDeviceVersion() {
            return pjson.version;
        },
        async getLatestVersion() {
            return await new Promise(resolve => {
                let to = config.modules_config.system.version_check.remote_device;
                NodeClient.sendRequest({to: to, method: 'getDeviceLatestVersion', payload: config.modules_config.system.version_check},(data)=>{
                    resolve(data);
                })
            });
        },
        async upgrade() {
            return await new Promise(resolve => {
                let to = config.modules_config.system.version_check.remote_device;
                let stream = ss.createStream({objectMode:true});
                ss(NodeClient.socket).emit('streamMessage',stream,{from: NodeClient.deviceId, to: to, method: 'getModuleSource', payload: config.modules_config.system.version_check},(res)=>{
                    console.log(res);
                });
                stream.on('data',(data)=>{
                   console.log(data);
                });
                stream.pipe(fs.createWriteStream('/tmp/stream.txt'));
            });
        },
        readFile(file) {
            let content = fs.readFileSync(file,'utf8');
            return content;
        },
        writeFile(file, content) {
            let res = fs.writeFileSync(file, content);
            return res;
        },
        appendFile(file, line) {
            let res = fs.appendFileSync(file, line);
            return res;
        },
        fileExists(file) {
            let res = fs.existsSync(file);
            return res;
        },
        tailFile(stream, file, ack) {
            const mytail = new Tail(file);
            mytail.on('line', (line) => {
                stream.write(line);
            });
            stream.on('end',()=>{
                mytail.stop();
            });
            stream.on('unpipe',()=>{
                mytail.stop();
            });
            // NodeClientUtil.debugStreamEvents(stream);
            mytail.start();
            if(ack) {
                ack('OK');
            }
        },
        getClientModules() {
            return NodeClient.modules
        }
    }
};
module.exports = NodeClient;
