// app.js (Entry point)
import { initializeSwarm, startMediaStreaming, leaveSwarm } from './streaming.js';
import { setupUIEvents } from './ui.js';

const { teardown, updates } = Pear;

let swarm = initializeSwarm();
console.log('Hyperswarm instance created.');

// Register swarm.destroy as the teardown handler
teardown(() => swarm?.destroy());
updates(() => Pear.reload());

// Call teardown when the window is closed
window.addEventListener('beforeunload', () => {
    teardown();
    console.log('Teardown called on window close');
});

document.addEventListener('DOMContentLoaded', () => {
    setupUIEvents();

    const topicInput = document.getElementById('topic-input');
    const joinBtn = document.getElementById('join-btn');
    const disconnectBtn = document.getElementById('disconnect-btn');

    // Handle Join button click
    joinBtn.addEventListener('click', async () => {
        const topic = topicInput.value.trim();
        if (!topic) {
            alert('Please enter a topic.');
            return;
        }

        try {
            // Disable Join button and enable Disconnect button
            joinBtn.disabled = true;
            disconnectBtn.disabled = false;

            if (!swarm) {
                swarm = initializeSwarm();
            }

            await startMediaStreaming(swarm, topic);
            console.log(`Joined swarm with topic: ${topic}`);
        } catch (error) {
            console.error('Failed to join swarm:', error);
            alert(`Failed to join swarm: ${error.message}`);
            // Re-enable Join button and disable Disconnect button on error
            joinBtn.disabled = false;
            disconnectBtn.disabled = true;
        }
    });

    // Handle Disconnect button click
    disconnectBtn.addEventListener('click', () => {
        leaveSwarm(swarm);

        swarm.destroy();
        swarm = null;

        // Update button states
        joinBtn.disabled = false;
        disconnectBtn.disabled = true;
        console.log('Disconnected from swarm');
    });
});