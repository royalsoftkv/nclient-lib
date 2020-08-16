module.exports = {

    debugStreamEvents(stream) {
        stream.on('data',()=>{
            console.log('stream:data', arguments);
        });
        stream.on('end',()=>{
            console.log('stream:end', arguments);
        });
        stream.on('error',()=>{
            console.log('stream:error', arguments);
        });
        stream.on('close',()=>{
            console.log('stream:close', arguments);
        });
        stream.on('readable',()=>{
            console.log('stream:readable', arguments);
        });
        stream.on('drain',()=>{
            console.log('stream:drain', arguments);
        });
        stream.on('finish',()=>{
            console.log('stream:finish', arguments);
        });
        stream.on('close',()=>{
            console.log('stream:close', arguments);
        });
        stream.on('pipe',()=>{
            console.log('stream:pipe', arguments);
        });
        stream.on('unpipe',()=>{
            console.log('stream:unpipe', arguments);
        });
    }

};
