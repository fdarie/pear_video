import Hyperswarm from 'hyperswarm';
const { teardown, updates } = Pear;

const swarm = new Hyperswarm();
console.log('Hyperswarm instance created.');

teardown(() => swarm.destroy());
updates(() => Pear.reload());

let encoder = null;
let encodingActive = false;
let currentConnections = [];
let encodeKeyFrameRequired = true;
let decodeKeyFrameRequired = true;

document.addEventListener('DOMContentLoaded', () => {
    const videoContainer = document.querySelector('.video-container');

    videoContainer.addEventListener('click', (event) => {
        const canvasWrapper = event.target.closest('.canvas-wrapper');

        if (canvasWrapper) {
            const canvas = canvasWrapper.querySelector('canvas');
            if (canvasWrapper.classList.contains('fullscreen-wrapper')) {
                // Exit fullscreen mode
                canvasWrapper.classList.remove('fullscreen-wrapper');
                canvas.classList.remove('fullscreen-canvas');
            } else {
                // Enter fullscreen mode
                canvasWrapper.classList.add('fullscreen-wrapper');
                canvas.classList.add('fullscreen-canvas');
            }
        }
    });
});

async function startVideoStreaming() {
    try {
        const options = { types: ['screen'] };
        const sources = await Pear.media.desktopSources(options);
        console.log('Available sources:', sources);

        if (!sources || sources.length === 0) {
            throw new Error('No desktop sources available.');
        }

        const selectedSource = sources.find(source => source.name.toLowerCase().includes('screen')) || sources[0];
        const sourceId = selectedSource.id;
        console.log('Selected source:', selectedSource);

        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId
                }
            }
        });

        console.log('Screen stream captured successfully:', stream);

        const localCanvas = document.querySelector('#localCanvas');
        const localCtx = localCanvas.getContext('2d');
        const videoElement = document.createElement('video');
        videoElement.srcObject = stream;
        videoElement.play();

        let fps = 30;
        let frameInterval = 1000 / fps;

        videoElement.onloadedmetadata = () => {
            localCanvas.width = videoElement.videoWidth;
            localCanvas.height = videoElement.videoHeight;

            encoder = new VideoEncoder({
                output: handleEncodedFrame,
                error: (err) => console.error('Encoder error:', err),
            });
            encoder.configure({
                codec: 'avc1.640033',
                avc: { format: "annexb" },
                width: videoElement.videoWidth,
                height: videoElement.videoHeight,
                bitrate: 5000000,
                framerate: fps,
                hardwareAcceleration: 'no-preference',
                optimizeForLatency: true,
            });

            console.log('Encoder configured with video dimensions:', videoElement.videoWidth, videoElement.videoHeight);
            encodeFrame();
        };

        function encodeFrame() {
            localCtx.drawImage(videoElement, 0, 0, localCanvas.width, localCanvas.height);
            if (encodingActive) {
                const frame = new VideoFrame(localCanvas, { timestamp: performance.now() * 1000 });
                encoder.encode(frame, { keyFrame: encodeKeyFrameRequired });
                frame.close();
                encodeKeyFrameRequired = false; // Reset after sending a key frame
            }
            setTimeout(encodeFrame, frameInterval);
        }

        const topic = Buffer.alloc(32).fill('p2p-video-sharing');
        console.log('Topic buffer created:', topic);

        const discovery = swarm.join(topic, { client: true, server: true });
        discovery.flushed();

        console.log('Joined the P2P swarm with topic.');

        swarm.on('connection', (connection, info) => {
            console.log('Peer connected! Info:', info);

            currentConnections.push(connection);
            connection.id = currentConnections.length;
            createRemoteCanvas(connection);

            // Setup connection.
            connection.on('data', (chunkData) => {
                const isKeyFrame = chunkData[0] === 1;
                const videoData = chunkData.slice(1);
                const decoder = connection.decoder;
                if (decoder) {

                    if (!isKeyFrame && decodeKeyFrameRequired)
                        return;

                    const chunk = new EncodedVideoChunk({
                        type: isKeyFrame ? 'key' : 'delta',
                        timestamp: performance.now() * 1000,
                        data: new Uint8Array(videoData)
                    });
                    decoder.decode(chunk);
                    decodeKeyFrameRequired = false;
                }
            });

            connection.on('close', () => handleConnectionClose(connection, 'closed'));
            connection.on('error', (err) => handleConnectionClose(connection, 'error', err));
            
            document.getElementById('peers-count').textContent = currentConnections.length;

            encodeKeyFrameRequired = true;
            decodeKeyFrameRequired = true;
            encodingActive = true;
        });

        function handleEncodedFrame(chunk) {
            currentConnections.forEach((connection) => {
                if (encodingActive) {
                    const chunkData = new Uint8Array(chunk.byteLength + 1);
                    chunkData[0] = chunk.type === 'key' ? 1 : 0; // Prepend key frame metadata
                    // Copy the chunk data starting from index 1
                    chunk.copyTo(new Uint8Array(chunkData.buffer, 1));
                    connection.write(chunkData);
                }
            });
        }

        function handleConnectionClose(connection, reason, error = null) {
            console.log(`Connection id: ${connection.id} closed due to ${reason}.`);
            if (error) {
                console.error('Connection error details:', error);
            }

            currentConnections = currentConnections.filter(conn => conn !== connection);
            encodingActive = currentConnections.length > 0;

            const remoteCanvas = document.getElementById(`remoteCanvas-${connection.id}`);
            if (remoteCanvas) {
                remoteCanvas.remove();
                console.log(`Removed remote canvas for connection ${connection.id}.`);
            }

            // Update peer count
            document.getElementById('peers-count').textContent = currentConnections.length;

            console.log(`Current active connections: ${currentConnections.length}`);
            rearrangeCanvases();
        }

        function rearrangeCanvases() {
            const videoContainer = document.querySelector('.video-container');
            const canvasWrappers = videoContainer.querySelectorAll('.canvas-wrapper');
            const totalCanvases = canvasWrappers.length;
        
            // Calculate the ideal number of columns (minimum 2)
            const columns = Math.max(2, Math.ceil(Math.sqrt(totalCanvases)));
        
            canvasWrappers.forEach((wrapper) => {
                wrapper.style.width = `calc(${100 / columns}% - 20px)`;
            });
        }

        function createRemoteCanvas(connection) {
            const remoteCanvasWrapper = document.createElement('div');
            remoteCanvasWrapper.className = 'canvas-wrapper';
            const remoteCanvas = document.createElement('canvas');
            remoteCanvas.id = `remoteCanvas-${connection.id}`;
            remoteCanvas.className = 'remoteCanvas';
            remoteCanvasWrapper.appendChild(remoteCanvas);
            document.querySelector('.video-container').appendChild(remoteCanvasWrapper);

            const remoteCtx = remoteCanvas.getContext('2d');
            remoteCanvas.width = localCanvas.width;
            remoteCanvas.height = localCanvas.height;

            const decoder = new VideoDecoder({
                output: (frame) => {
                    remoteCtx.drawImage(frame, 0, 0, remoteCanvas.width, remoteCanvas.height);
                    frame.close();
                },
                error: (err) => console.error('Decoder error:', err),
            });
            decoder.configure({
                codec: 'avc1.640033',
                avc: { format: "annexb" },
                width: remoteCanvas.width,
                height: remoteCanvas.height,
                bitrate: 5000000,
                framerate: fps,
                hardwareAcceleration: 'no-preference',
                optimizeForLatency: true,
            });

            connection.decoder = decoder;
            console.log(`Decoder configured for connection ${connection.id}.`);
        }

    } catch (error) {
        console.error('Error accessing display media:', error);
        alert(`Failed to start screen capture: ${error.message}`);
    }
}

startVideoStreaming();
