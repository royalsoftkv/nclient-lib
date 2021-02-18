const NodeClient = require("./NodeClient")
const pjson = require(process.cwd() + '/package.json')
const fs = require("fs")
const ss = require('socket.io-stream')
const Tail = require('tail-file')

let configFilePath = process.cwd()+'/config.json';
let config = {};
if(fs.existsSync(configFilePath)) {
    config = require(process.cwd()+'/config.json');
}

const commonHandler = {
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
    getDeviceVersion(params, cb) {
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
    readFile(params, cb) {
        file=params.file
        let content = fs.readFileSync(file,'utf8');
        cb(content)
    },
    writeFile(params, cb) {
        let file = params.file
        let content = params.content
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
        mytail.start();
        if(ack) {
            ack('OK');
        }
    },
    getClientModules(params, cb) {
        cb(NodeClient.modules)
    },
    readConfig(params, cb) {
        let  {module, file} = params
        cb(NodeClient.readConfig(module, file))
    },
    storeConfig(params, cb) {
        let  {module, file, content} = params
        cb(NodeClient.storeConfig(module, file, content))
    },
}

module.exports = commonHandler
