// ui.js (Handles UI interactions)

export function setupUIEvents() {
  const videoContainer = document.querySelector('.video-container');

  videoContainer.addEventListener('click', (event) => {
    const videoWrapper = event.target.closest('.video-wrapper');

    if (videoWrapper) {
      const video = videoWrapper.querySelector('video');
      if (videoWrapper.classList.contains('fullscreen-wrapper')) {
        // Exit fullscreen mode
        videoWrapper.classList.remove('fullscreen-wrapper');
        video.classList.remove('fullscreen-video');
      } else {
        // Enter fullscreen mode
        videoWrapper.classList.add('fullscreen-wrapper');
        video.classList.add('fullscreen-video');
      }
    }
  });
}
