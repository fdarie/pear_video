// streaming.js (Handles video and audio streaming logic)
import Hyperswarm from 'hyperswarm';

let videoEncoder = null;
let audioEncoder = null;
let videoReader = null;
let audioReader = null;
let encodingActive = false;
let currentConnections = [];
let encodeKeyFrameRequired = true;
let decodeKeyFrameRequired = true;
let videoSettings = null


export function initializeSwarm() {
  return new Hyperswarm();
}

export async function startMediaStreaming(swarm) {
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
    
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    console.log('Screen stream captured successfully:', stream);

    // Get video and audio tracks
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = audioStream.getAudioTracks()[0];

    console.assert(audioTrack != null, 'Audio tracker should not be null!');

    // Elements
    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = stream;
    

    // Video Track Processor and Reader
    const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
    videoReader = videoProcessor.readable.getReader();

    // Audio Track Processor and Reader
    const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
    audioReader = audioProcessor.readable.getReader();

    // Encoders
    videoEncoder = new VideoEncoder({
      output: handleEncodedVideoChunk,
      error: (err) => console.error('Video Encoder error:', err),
    });

    audioEncoder = new AudioEncoder({
      output: handleEncodedAudioChunk,
      error: (err) => console.error('Audio Encoder error:', err),
    });

    // Configure Video Encoder
    videoSettings = videoTrack.getSettings();
    videoEncoder.configure({
      codec: 'avc1.640033',
      avc: { format: "annexb" },
      width: videoSettings.width,
      height: videoSettings.height,
      bitrate: 5000000,
      framerate: videoSettings.frameRate || 30,
      hardwareAcceleration: 'no-preference',
      optimizeForLatency: true,
    });

    // Configure Audio Encoder
    const audioSettings = audioTrack.getSettings();
    audioEncoder.configure({
      codec: 'opus',
      sampleRate: audioSettings.sampleRate || 48000,
      numberOfChannels: audioSettings.channelCount || 2,
      bitrate: 128000,
    });

    // Start Reading and Encoding Video and Audio Frames
    encodingActive = true;
    readAndEncodeVideoFrames();
    readAndEncodeAudioFrames();

    // Handle Swarm Connections
    swarm.on('connection', async (connection, info) => {
      console.log('Peer connected! Info:', info);

      currentConnections.push(connection);
      connection.id = currentConnections.length;
      createRemoteMediaElements(connection);

      connection.on('data', (chunkData) => {
        handleIncomingData(connection, chunkData);
      });

      connection.on('close', () => handleConnectionClose(connection, 'closed'));
      connection.on('error', (err) => handleConnectionClose(connection, 'error', err));

      document.getElementById('peers-count').textContent = currentConnections.length;

      encodeKeyFrameRequired = true;
      decodeKeyFrameRequired = true;
      await localVideo.play();
    });

    // Join Swarm
    const topic = Buffer.alloc(32).fill('p2p-media-sharing');
    console.log('Topic buffer created:', topic);

    const discovery = swarm.join(topic, { client: true, server: true });
    await discovery.flushed();

    console.log('Joined the P2P swarm with topic.');
  } catch (error) {
    console.error('Error accessing display media:', error);
    alert(`Failed to start screen capture: ${error.message}`);
  }
}

async function readAndEncodeVideoFrames() {
  while (encodingActive) {
    const result = await videoReader.read();
    if (result.done) break;
    const frame = result.value;
    if (videoEncoder.state != 'configured') {
      frame.close();
      return;
    }
    videoEncoder.encode(frame, { keyFrame: encodeKeyFrameRequired });
    frame.close();
    encodeKeyFrameRequired = false;
  }
}

async function readAndEncodeAudioFrames() {
  while (encodingActive) {
    const result = await audioReader.read();
    if (result.done) break;
    const frame = result.value;
    if (audioEncoder.state != 'configured') {
      frame.close(); 
      return;
    }
    audioEncoder.encode(frame);
    frame.close();
  }
}

async function handleEncodedVideoChunk(chunk) {
  if (!encodingActive) return;

  // Prepare data packet: [type (1 byte), keyFrame (1 byte), chunk data]
  const chunkData = new Uint8Array(chunk.byteLength + 2);
  chunkData[0] = 1; // Type 1 for video
  chunkData[1] = chunk.type === 'key' ? 1 : 0; // Key frame indicator
  chunk.copyTo(new Uint8Array(chunkData.buffer, 2));

  await sendDataToConnections(chunkData);
}

async function handleEncodedAudioChunk(chunk) {
  if (!encodingActive) return;

  // Prepare data packet: [type (1 byte), chunk data]
  const chunkData = new Uint8Array(chunk.byteLength + 1);
  chunkData[0] = 2; // Type 2 for audio
  chunk.copyTo(new Uint8Array(chunkData.buffer, 1));

  await sendDataToConnections(chunkData);
}

async function sendDataToConnections(chunkData) {
  const writePromises = currentConnections.map(async (connection) => {
    try {
      await connection.write(chunkData);
    } catch (error) {
      console.error(`Failed to write to connection ${connection.id}:`, error);
      return { connection, error };
    }
  });

  const results = await Promise.all(writePromises);

  const failedConnections = results.filter(result => result && result.error);
  failedConnections.forEach(({ connection, error }) => {
    handleConnectionClose(connection, 'write error', error);
  });
}

function handleIncomingData(connection, chunkData) {
  const type = chunkData[0];
  if (type === 1) {
    // Video data
    const isKeyFrame = chunkData[1] === 1;
    const videoData = chunkData.slice(2);
    const videoDecoder = connection.videoDecoder;

    if (videoDecoder) {
      if (!isKeyFrame && decodeKeyFrameRequired) return;

      try {
        const chunk = new EncodedVideoChunk({
          type: isKeyFrame ? 'key' : 'delta',
          timestamp: performance.now() * 1000,
          data: new Uint8Array(videoData)
        });
        videoDecoder.decode(chunk);
        decodeKeyFrameRequired = false;
      } catch (error) {
        console.error('Error decoding video chunk:', error);
        decodeKeyFrameRequired = true;
      }
    }
  } else if (type === 2) {
    // Audio data
    const audioData = chunkData.slice(1);
    const audioDecoder = connection.audioDecoder;

    if (audioDecoder) {
      try {
        const chunk = new EncodedAudioChunk({
          type: 'key', // For Opus codec, treat all chunks as key frames
          timestamp: performance.now() * 1000,
          data: new Uint8Array(audioData)
        });
        audioDecoder.decode(chunk);
      } catch (error) {
        console.error('Error decoding audio chunk:', error);
      }
    }
  }
}

function createRemoteMediaElements(connection) {
  // Create a video element for remote media
  const remoteVideoWrapper = document.createElement('div');
  remoteVideoWrapper.className = 'video-wrapper';
  const remoteVideo = document.createElement('video');
  remoteVideo.id = `remoteVideo-${connection.id}`;
  remoteVideo.className = 'remoteVideo';
  remoteVideo.autoplay = true;
  remoteVideo.playsInline = true;
  remoteVideoWrapper.appendChild(remoteVideo);
  document.querySelector('.video-container').appendChild(remoteVideoWrapper);

  // Create MediaStreamTrackGenerators
  const videoGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
  const audioGenerator = new MediaStreamTrackGenerator({ kind: 'audio' });

  // Create writable streams
  const videoWritable = videoGenerator.writable.getWriter();
  const audioWritable = audioGenerator.writable.getWriter();

  // Create MediaStream with generated tracks
  const remoteStream = new MediaStream([videoGenerator, audioGenerator]);

  // Set the stream as srcObject of the remote video element
  remoteVideo.srcObject = remoteStream;

  // Create decoders
  const videoDecoder = new VideoDecoder({
    output: (frame) => {
      videoWritable.write(frame).catch((e) => console.error('Video write error:', e));
      frame.close();
    },
    error: (err) => console.error('Video Decoder error:', err),
  });

  videoDecoder.configure({
    codec: 'avc1.640033',
    avc: { format: "annexb" },
    width: videoSettings.width,
    height: videoSettings.height,
    bitrate: 5000000,
    framerate: videoSettings.frameRate || 30,
    hardwareAcceleration: 'no-preference',
    optimizeForLatency: true,
  });

  const audioDecoder = new AudioDecoder({
    output: (frame) => {
      audioWritable.write(frame).catch((e) => console.error('Audio write error:', e));
      frame.close();
    },
    error: (err) => console.error('Audio Decoder error:', err),
  });

  audioDecoder.configure({
    codec: 'opus',
    sampleRate: 48000,
    numberOfChannels: 2,
  });

  // Assign decoders and elements to the connection
  connection.videoDecoder = videoDecoder;
  connection.audioDecoder = audioDecoder;
  connection.remoteVideo = remoteVideo;

  console.log(`Decoders configured for connection ${connection.id}.`);
}

function handleConnectionClose(connection, reason, error = null) {
  console.log(`Connection id: ${connection.id} closed due to ${reason}.`);
  if (error) {
    console.error('Connection error details:', error);
  }

  currentConnections = currentConnections.filter(conn => conn !== connection);
  encodingActive = currentConnections.length > 0;

  // Remove remote video element
  const remoteVideo = document.getElementById(`remoteVideo-${connection.id}`);
  if (remoteVideo) {
    remoteVideo.parentElement.remove();
    console.log(`Removed remote video element for connection ${connection.id}.`);
  }

  document.getElementById('peers-count').textContent = currentConnections.length;
  console.log(`Current active connections: ${currentConnections.length}`);
}
