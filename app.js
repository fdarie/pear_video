// app.js (Entry point)
import { initializeSwarm, startMediaStreaming } from './streaming.js';
import { setupUIEvents } from './ui.js';

const { teardown, updates } = Pear;

const swarm = initializeSwarm();
console.log('Hyperswarm instance created.');

teardown(() => swarm.destroy());
updates(() => Pear.reload());

document.addEventListener('DOMContentLoaded', async () => {
  setupUIEvents();
  await startMediaStreaming(swarm);
});
