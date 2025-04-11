// streaming.js (Handles video and audio streaming logic)
import Hyperswarm from 'hyperswarm';

// Global flag to enable/disable audio (set to false to disable audio)
const ENABLE_AUDIO = false;

let videoEncoder = null;
let audioEncoder = null;
let videoReader = null;
let audioReader = null;
let encodingActive = false;
let currentConnections = [];
let encodeKeyFrameRequired = true;
let decodeKeyFrameRequired = true;
let videoSettings = null;
let lastKeyFrameTime = 0; // Track time of last keyframe
let lastFrame = null; // Store the last captured frame
const KEYFRAME_INTERVAL = 1000; // 1 second in milliseconds

export function initializeSwarm() {
  return new Hyperswarm();
}

// Helper function to poll Pear.media.desktopSources until it returns sources
async function getDesktopSourcesWithRetry(options, retryInterval = 1000, maxRetries = 30) {
  let attempts = 0;

  while (attempts < maxRetries) {
    try {
      const sources = await Pear.media.desktopSources(options);
      console.log(`Attempt ${attempts + 1}: Raw sources from Pear:`, sources);

      if (sources && sources.length > 0) {
        return sources; // Success: non-null and non-empty
      }

      console.warn(`No sources available on attempt ${attempts + 1}. Retrying in ${retryInterval}ms...`);
    } catch (error) {
      console.error(`Attempt ${attempts + 1} failed:`, error);
    }

    attempts++;
    await new Promise(resolve => setTimeout(resolve, retryInterval)); // Wait before retrying
  }

  throw new Error(`Failed to get desktop sources after ${maxRetries} attempts.`);
}

export async function startMediaStreaming(swarm) {
  try {
    const options = { types: ['screen'] };

    // Poll Pear.media.desktopSources until we get valid sources
    const sources = await getDesktopSourcesWithRetry(options);
    console.log('Successfully retrieved sources:', sources);

    // Auto-select a screen source or default to the first one
    const selectedSource = sources.find(source => source.name.toLowerCase().includes('screen')) || sources[0];
    const sourceId = selectedSource.id;
    console.log('Selected source:', selectedSource);

    // Request the media stream with the selected source
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      }
    });

    let audioStream = null;
    if (ENABLE_AUDIO) {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    console.log('Screen and audio streams captured successfully:', stream, audioStream);

    // Get video and audio tracks
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = ENABLE_AUDIO && audioStream ? audioStream.getAudioTracks()[0] : null;

    console.assert(videoTrack != null, 'Video track should not be null!');
    if (ENABLE_AUDIO) {
      console.assert(audioTrack != null, 'Audio track should not be null!');
    }

    // Elements
    const localVideo = document.getElementById('localVideo');
    localVideo.srcObject = stream;

    // Video Track Processor and Reader
    const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
    videoReader = videoProcessor.readable.getReader();

    // Audio Track Processor and Reader
    if (ENABLE_AUDIO && audioTrack) {
      const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
      audioReader = audioProcessor.readable.getReader();
    }

    // Encoders
    videoEncoder = new VideoEncoder({
      output: handleEncodedVideoChunk,
      error: (err) => console.error('Video Encoder error:', err),
    });

    if (ENABLE_AUDIO) {
      audioEncoder = new AudioEncoder({
        output: handleEncodedAudioChunk,
        error: (err) => console.error('Audio Encoder error:', err),
      });
    }

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
    if (ENABLE_AUDIO && audioTrack) {
      const audioSettings = audioTrack.getSettings();
      audioEncoder.configure({
        codec: 'opus',
        sampleRate: audioSettings.sampleRate || 48000,
        numberOfChannels: audioSettings.channelCount || 2,
        bitrate: 128000,
      });
    }

    // Start Reading and Encoding Video and Audio Frames
    encodingActive = true;
    readAndEncodeVideoFrames();
    if (ENABLE_AUDIO) {
      readAndEncodeAudioFrames();
    }

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
    const topic = Buffer.alloc(32).fill('p2p-screen-sharing');
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
  // Start a separate timer to force keyframes every second
  const forceKeyFrameInterval = setInterval(() => {
    if (encodingActive && videoEncoder?.state === 'configured' && lastFrame) {
      // Reuse the last frame to encode a keyframe
      videoEncoder.encode(lastFrame, { keyFrame: true });
    }
  }, KEYFRAME_INTERVAL);

  try {
    while (encodingActive) {
      const result = await videoReader.read();
      if (result.done) break;
      const frame = result.value;
      if (videoEncoder.state !== 'configured') {
        frame.close();
        break;
      }

      // Store the frame for reuse in forced keyframes
      if (lastFrame) {
        lastFrame.close(); // Close previous frame to avoid memory leaks
      }
      lastFrame = frame;

      // Encode the frame normally (keyframe only if required, e.g., new connection)
      videoEncoder.encode(frame, { keyFrame: encodeKeyFrameRequired });
      encodeKeyFrameRequired = false;
    }
  } finally {
    // Clean up interval and last frame when done
    clearInterval(forceKeyFrameInterval);
    if (lastFrame) {
      lastFrame.close();
      lastFrame = null;
    }
  }
}

async function readAndEncodeAudioFrames() {
  if (!ENABLE_AUDIO) return;
  while (encodingActive) {
    const result = await audioReader.read();
    if (result.done) break;
    const frame = result.value;
    if (audioEncoder.state !== 'configured') {
      frame.close();
      return;
    }
    audioEncoder.encode(frame);
    frame.close();
  }
}

async function handleEncodedVideoChunk(chunk) {
  if (!encodingActive) return;

  const chunkData = new Uint8Array(chunk.byteLength + 2);
  chunkData[0] = 1; // Type 1 for video
  chunkData[1] = chunk.type === 'key' ? 1 : 0; // Key frame indicator
  chunk.copyTo(new Uint8Array(chunkData.buffer, 2));

  await sendDataToConnections(chunkData);
}

async function handleEncodedAudioChunk(chunk) {
  if (!ENABLE_AUDIO || !encodingActive) return;

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
  } else if (ENABLE_AUDIO && type === 2) {
    const audioData = chunkData.slice(1);
    const audioDecoder = connection.audioDecoder;

    if (audioDecoder) {
      try {
        const chunk = new EncodedAudioChunk({
          type: 'key',
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
  const remoteVideoWrapper = document.createElement('div');
  remoteVideoWrapper.className = 'video-wrapper';
  const remoteVideo = document.createElement('video');
  remoteVideo.id = `remoteVideo-${connection.id}`;
  remoteVideo.className = 'remoteVideo';
  remoteVideo.autoplay = true;
  remoteVideo.playsInline = true;
  remoteVideoWrapper.appendChild(remoteVideo);
  document.querySelector('.video-container').appendChild(remoteVideoWrapper);

  const videoGenerator = new MediaStreamTrackGenerator({ kind: 'video' });
  let audioGenerator = null;
  if (ENABLE_AUDIO) {
    audioGenerator = new MediaStreamTrackGenerator({ kind: 'audio' });
  }

  const videoWritable = videoGenerator.writable.getWriter();
  let audioWritable = null;
  if (ENABLE_AUDIO && audioGenerator) {
    audioWritable = audioGenerator.writable.getWriter();
  }

  const tracks = [videoGenerator];
  if (ENABLE_AUDIO && audioGenerator) {
    tracks.push(audioGenerator);
  }
  const remoteStream = new MediaStream(tracks);
  remoteVideo.srcObject = remoteStream;

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

  let audioDecoder = null;
  if (ENABLE_AUDIO) {
    audioDecoder = new AudioDecoder({
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
  }

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

  const remoteVideo = document.getElementById(`remoteVideo-${connection.id}`);
  if (remoteVideo) {
    remoteVideo.parentElement.remove();
    console.log(`Removed remote video element for connection ${connection.id}.`);
  }

  document.getElementById('peers-count').textContent = currentConnections.length;
  console.log(`Current active connections: ${currentConnections.length}`);
}