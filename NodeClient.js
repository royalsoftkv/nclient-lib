/**
 * NodeClient.js v1.0.25
 */

const { exec, spawn } = require('child_process');
const fs = require("fs");
const path = require("path");
const uuidv4 = require('uuid/v4')
const Tail = require('tail-file')
const crypt = require("./crypt")
const jwt = require('jsonwebtoken')

let configFilePath = process.cwd()+'/config.json';
let config = {
    connect_secret: undefined
};
if(fs.existsSync(configFilePath)) {
    config = require(process.cwd()+'/config.json');
}

const ss = require('socket.io-stream');
const SocketUtil = require("./SocketUtil")

/** override destroy method to stop stream propagation **/
const IOStream = ss.IOStream
IOStream.prototype.destroy = function() {

    if (this.destroyed) {
        return;
    }

    this.readable = this.writable = false;

    if (this.socket) {
        this.socket.cleanup(this.id);
        this.socket = null;
    }
    this.emit('destroyed')
    this.destroyed = true;
};

let onExecNodeStream = (stream, method, params, ack) => {
    try {
        console.log(`Received execNodeStream ${method}`)
        let fn = findFunction(method)
        if(typeof fn !== 'function') {
            console.log(`Method ${method} not found`);
            ack({error:{message:`Method ${method} not found`, code:'DEVICE_METHOD_NOT_FOUND'}});
            return;
        }
        ack(fn(stream, params, ack));
    } catch(e) {
        let res = {error:{message:e.message, stack:e.stack, code:'DEVICE_METHOD_ERROR'}};
        ack(res);
    }
}

let getConnectionParams = (params = {}) => {
    let secret
    if(!params.secret) {
        secret = config.connect_secret;
    }
    return {
        secret: secret,
        deviceId: NodeClient.deviceId,
        processId: process.pid,
        modules: config.modules || [],
        version: nclientVersion()
    }
}

let findFunction = (method) => {
    let fn = NodeClient.remoteHandler[method];
    if(!fn) {
        fn = NodeClient.methods[method];
    }
    if(!fn) {
        fn = global[method];
    }
    return fn
}

let onExecNodeMethod = (method, params, ack) => {
    //console.log(`execNodeMethod method=${method} params=${params}`)
    let fn = findFunction(method)
    if(typeof fn !== 'function') {
        console.log(`Method ${method} not found`);
        if(typeof ack === 'function') {
            ack({error:{message:`Method ${method} not found`,status:'DEVICE_METHOD_NOT_FOUND',stack:Error().stack}});
        }
        return;
    }
    const isAsync = fn.constructor.name === "AsyncFunction";
    if(isAsync) {
        new Promise(async function (resolve, reject) {
            let res;
            try {
                //console.log('Calling function: res = await fn(params);')
                res = await fn(params);
            } catch (e) {
                res = {error: {message: e.message, stack: e.stack, code: 'DEVICE_METHOD_ERROR'}};
            }
            if (typeof ack === 'function') {
                // console.log("Resolve: resolve(ack(res))")
                // console.log("res", res)
                resolve(ack(res));
            } else {
                // console.log("Resolve: resolve(res)")
                resolve(res);
            }
        }).then();
    } else {
        if(typeof ack === 'function') {
            //console.log('Calling function: fn.apply(this, [params, ack])')
            try {
            fn.apply(this, [params, ack])
            } catch(e) {
                let err = {error: {message: e.message, status: 'FUNCTION_ERROR'}}
                ack(err)
            }
        } else {
            try {
                //console.log('Calling function: res = fn(params);')
                fn(params);
            } catch(e) {
                console.log({error:{message:e.message, stack:e.stack, code:'DEVICE_METHOD_ERROR'}})
            }
        }
    }
}

let nclientVersion = () => {
    let pjson = require('./package.json')
    return pjson.version
}

let checkToken = (socket, token, ack) => {
    if(!token) {
        if (typeof ack === "function") {
            ack({error: {message: `Missing jwt token in payload`, status: 'MISSING_TOKEN'}});
            return false
        }
    }
    try {
        let decoded = jwt.verify(token, NodeClient.publicKey);
        //console.log(decoded)
    } catch (e) {
        if(e.message === "jwt expired") {
            ack({error: {message: `Error decoding token`, status: 'TOKEN_EXPIRED'}});
        } else {
            ack({error: {message: `Error decoding token`, status: 'TOKEN_ERROR'}});
        }
        return false
    }
    return true
}



const NodeClient = {

    SOCKET_SECRET: 'netsock',
    socket : null,
    deviceId: null,
    handler: null,
    modules: [],
    methods: {},
    streamRegistry: {},
    mqtt: null,
    onConnect: null,
    socketEventHandlers: {},
    keys: {},
    token: null,
    remoteHandler: {
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
        getDeviceVersion(params, cb) {
            const pjson = require(process.cwd() + '/package.json');
            cb(pjson.version)
        },
        async getLatestVersion() {
            return await new Promise(resolve => {

                let to = config.modules_config.system.version_check.remote_device;
                NodeClient.execNodeMethod(to, 'getDeviceLatestVersion', config.modules_config.system.version_check, data => {
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
        getClientModules(params, cb) {
            cb(NodeClient.modules)
        },
        async updateNode() {
            let res = await NodeClient.commonHandler.execCmd('npm update')
            if(res.stderr) {
                let res = await NodeClient.commonHandler.execCmd('./node ./npm update')
                return res.stdout
            } else {
                return res.stdout
            }
        },
        readNodeConfigFile(params, cb) {
            let file = path.join(process.cwd(),'config.json')
            NodeClient.commonHandler.readFile(file,cb)
        },
        writeNodeConfigFile(params, cb) {
            let file = path.join(process.cwd(),'config.json')
            let content = params.content
            NodeClient.commonHandler.writeFile(file, content, cb)
        },
        readConfig(params, cb) {
            let  {module, file} = params
            cb(NodeClient.readConfig(module, file))
        },
        storeConfig(params, cb) {
            let  {module, file, content} = params
            cb(NodeClient.storeConfig(module, file, content))
        },
    },
    commonHandler: {
        async execCmd(cmd) {

            let hookFn = NodeClient.hooks && NodeClient.hooks.beforeExecCmd;
            if(typeof hookFn === 'function') {
                cmd = hookFn(cmd);
            }

            //console.log(`Executing shell command: ${cmd}`);
            return new Promise(function(resolve, reject) {
                exec(cmd, (err, stdout, stderr) => {
                    if (err) {
                        // node couldn't execute the command
                        console.log(JSON.stringify(err));
                        //reject(err);
                    }
                    resolve({
                        stdout:stdout,
                        stderr:stderr
                    });
                });
            });
        },
        readFile(file, cb) {
            let content = fs.readFileSync(file,'utf8');
            cb(content)
        },
        writeFile(file, content, cb) {
            let res = fs.writeFileSync(file, content);
            cb(res)
        },
        appendFile(params, cb) {
            let  { file, line} = params
            let res = fs.appendFileSync(file, line);
            cb(res)
        },
        fileExists(file, cb) {
            let res = fs.existsSync(file);
            cb(res)
        },
        tailFile(stream, file, ack) {
            let cmd = spawn('tail', ['-f', file]);
            cmd.stdout.pipe(stream);
            stream.on("destroyed", ()=>{
                cmd.kill("SIGTERM")
            })
            if(ack){
                ack(file)
            }
        },
    },

    start() {
        NodeClient.init();
        NodeClient.connect();
        NodeClient.handle();
        NodeClient.loadModules();
    },

    init(options=null) {
        let deviceId
        if(typeof options === "string") {
            deviceId = options
        } else {
            if(options && options.deviceId) {
                deviceId = options.deviceId
            }
        }
        if (deviceId) {
            this.deviceId = deviceId;
        } else {
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
                this.deviceId = deviceId;
            }
        this.keys = crypt.generateKeys(this.deviceId)
        console.debug(`Initialized node client for device ${this.deviceId}`)
    },

    connect(url= null, secret=null) {
        if(!url) {
            url = config.connect_url;
        }
        let query = getConnectionParams({secret: secret})
        query.pubKey = this.keys.publicKey
        this.socket = require('socket.io-client')(url, {
            query: query
        });
        console.debug(`Connecting to remote socket ${url}`)
    },

    onSocketEvent(socketEvent, fn) {
        SocketUtil.socketEventHandlers[socketEvent]=fn
    },

    handle() {

        let socket = this.socket;

        SocketUtil.handleCommonSocketEvents(socket)

        process.on('uncaughtException', function (e) {
            console.log(e)
        });

        socket.on("execNodeMethod", (payload, ack) => {
            let method, params

            let token = payload.token

            if(!checkToken(socket, token, ack)) {
                return
                }
            //
            // try {
            //     let decoded = jwt.verify(token, NodeClient.publicKey);
            //     console.log(decoded)
            // } catch (e) {
            //
            // }

            // if(typeof payload !== 'object') {
            //     try {
            //         let payloadDecypted = crypt.decrypt(payload, this.keys.privateKey, NodeClient.deviceId)
            //         payload = JSON.parse(payloadDecypted)
            //         method = payload.method
            //         params = payload.params
            //     } catch (e) {
            //         ack({error: true, message: e.message, stack: e.stack})
            //     }
            // } else {
            //     if(config.legacy && config.legacy.enabled) {
            //         if(payload.legacy) {
            //             method = payload.method
            //             params = payload.params
            //             if(config.legacy.methods && config.legacy.methods.includes(method)) {
            //                 console.log("allowed legacy call ", method)
            //             } else {
            //                 method = null
            //                 console.error("NO LEGACY CALL FOR METHOD ", method)
            //                 ack({error: true, message: "NOT ALLOWED METHOD FOR LEGACY CALL"})
            //             }
            //         } else {
            //             console.error("NO LEGACY")
            //             ack({error: true, message: "NOT MARKED LEGACY CALL"})
            //         }
            //     } else {
            //         console.error("NO LEGACY CALLS")
            //         ack({error: true, message: "NOT ALLOWED NON LEGACY CALLS"})
            //     }
            //
            // }

                        method = payload.method
                        params = payload.params

            if(method) {
                onExecNodeMethod(method, params, ack)
            }
        });

        socket.on("token", (data, ack)=>{
            console.log(`Received token ${data.token}`)
            this.token = data.token
            this.publicKey = data.publicKey
            SocketUtil.handleSocketEvent("client_connected", ack)
        })

        ss(socket).on('execNodeStream',  (stream, data, ack) => {
            let token = data.token
            if(!checkToken(socket, token, ack)) {
                return
            }
            onExecNodeStream(stream, data.method, data.params, ack)
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
            this.emit(event, params, res => {
                resolve(res);
            })
        })
    },

    emit(event, payload, cb){
        if(!this.socket.connected) {
            if(cb) {
                cb({error:{message:'Remote server not connected',status:'MEDIATOR_NOT_CONNECTED',stack:Error().stack}});
            }
        } else {
            payload.token = NodeClient.token
            this.socket.emit(event, payload, cb)
        }
    },

    execNodeMethod(deviceId, method, params, cb) {
        this.emit("execNodeMethod",{from: this.deviceId, to: deviceId, method: method, params: params}, cb);
    },

    async asyncExecNodeMethod(deviceId, method, params) {
        return await this.asyncEmit("execNodeMethod", {
            from: global.deviceId,
            to: deviceId,
            method: method,
            params: params
        });
    },

    execNodeStream(stream, method, deviceId, params, ack) {
        let fccStream = ss.createStream({objectMode:true});
        fccStream.pipe(stream);
        stream.on('destroyed', function() {
            console.log("stream:destroyed")
            fccStream.destroy()
        });
        ss(this.socket).emit('execNodeStream', fccStream,
            {from: NodeClient.deviceId, to:deviceId, method:method, params: params, token: NodeClient.token }, (res)=>{
            ack(res);
        });
    },

    callNodeStream(method, deviceId, params, ack, ondata) {
        let stream = ss.createStream({objectMode:true});
        stream.on("data", data =>{
            ondata(data)
        })
        ss(this.socket).emit('execNodeStream', stream, {
            from: NodeClient.deviceId, to:deviceId, method:method, params: params, token: NodeClient.token }, (res)=>{
            ack(res);
        });
    },

    storeData(params, cb) {
        let name = params.name
        let property = params.property
        let value = params.value
        NodeClient.execNodeMethod(null, 'storeData', {name, property, value}, cb)
    },

    readData(name, property, filter, cb) {
        NodeClient.execNodeMethod(null, 'readData', {name, property, filter}, cb)
    },

    execSQL(sql, params, cb) {
        NodeClient.execNodeMethod(null, 'execSQL', {sql, params}, cb)
    },

    registerNodeMethod(method, fn) {
        this.methods[method]=fn
    },

    registerNodeStream(method, onStart, onEnd) {
        let fn = (stream, params, ack) => {
            stream.on("destroyed", ()=>{
                onEnd(stream)
            })
            onStart(stream, params, ack)
        }
        this.methods[method]=fn
    },

    updateNodeStream(method, fn) {
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
        this.execNodeMethod(null, 'storeSocketData', { key, value, from: NodeClient.deviceId })
    },

};
module.exports = NodeClient;
