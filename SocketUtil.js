module.exports = {

    socketEventHandlers: {},

    handleCommonSocketEvents(socket) {

        socket.on("connect", ()=>{
            this.handleSocketEvent("connect")
        })

        socket.on("disconnect", (reason)=>{
            if(reason === 'io server disconnect') {
                setTimeout(()=>{
                    socket.connect();
                }, 5000)
            }
            this.handleSocketEvent("disconnect", reason)
        })

        socket.on("error", (error)=>{
            this.handleSocketEvent("error", error)
        })

        socket.on("connect_error", (error)=>{
            this.handleSocketEvent("connect_error", error)
        })

        socket.on('connect_timeout', (timeout) => {
            this.handleSocketEvent("connect_timeout", timeout)
        });

        socket.on('reconnect', (attemptNumber) => {
            this.handleSocketEvent("reconnect", attemptNumber)
        });

        socket.on('reconnect_attempt', (attemptNumber) => {
            this.handleSocketEvent("reconnect_attempt", attemptNumber)
        });

        socket.on('reconnecting', (attemptNumber) => {
            this.handleSocketEvent("reconnecting", attemptNumber)
        });

        socket.on('reconnect_error', (error) => {
            this.handleSocketEvent("reconnect_error", error)
        });

        socket.on('reconnect_failed', () => {
            this.handleSocketEvent("reconnect_failed")
        });

        socket.on('ping', () => {
            this.handleSocketEvent("ping")
        });

        socket.on('pong', (latency) => {
            this.handleSocketEvent("pong", latency)
        });
    },

    handleSocketEvent() {
        let args = [...arguments]
        let socketEvent = args.shift()
        if(typeof this.socketEventHandlers[socketEvent] === "function") {
            this.socketEventHandlers[socketEvent].apply(this, args)
        }
    },

}
