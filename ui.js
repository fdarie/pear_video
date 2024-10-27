// ui.js (Handles UI interactions)
export function setupUIEvents() {
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
  }
  