/**
 * Utility for creating and managing progress modals
 */

export function createProgressModal(title: string): HTMLDivElement {
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    `;
    
    const content = document.createElement('div');
    content.style.cssText = `
        background: #1e1e1e;
        padding: 30px;
        border-radius: 10px;
        min-width: 400px;
        max-width: 600px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    `;
    
    const titleElement = document.createElement('h2');
    titleElement.textContent = title;
    titleElement.style.cssText = `
        color: white;
        margin: 0 0 20px 0;
        font-size: 24px;
        text-align: center;
    `;
    
    const progressBarContainer = document.createElement('div');
    progressBarContainer.style.cssText = `
        background: #333;
        border-radius: 10px;
        height: 30px;
        margin-bottom: 15px;
        overflow: hidden;
        border: 1px solid #555;
    `;
    
    const progressBar = document.createElement('div');
    progressBar.id = 'progress-bar';
    progressBar.style.cssText = `
        background: linear-gradient(90deg, #4CAF50, #45a049);
        height: 100%;
        width: 0%;
        transition: width 0.3s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: bold;
        font-size: 14px;
    `;
    
    const messageElement = document.createElement('div');
    messageElement.id = 'progress-message';
    messageElement.style.cssText = `
        color: #aaa;
        font-size: 14px;
        text-align: center;
        min-height: 20px;
    `;
    messageElement.textContent = 'Initializing...';
    
    progressBarContainer.appendChild(progressBar);
    content.appendChild(titleElement);
    content.appendChild(progressBarContainer);
    content.appendChild(messageElement);
    modal.appendChild(content);
    document.body.appendChild(modal);
    
    return modal;
}

export function updateProgressModal(modal: HTMLDivElement, progress: number, message: string): void {
    const progressBar = modal.querySelector('#progress-bar') as HTMLDivElement;
    const messageElement = modal.querySelector('#progress-message') as HTMLDivElement;
    
    if (progressBar) {
        progressBar.style.width = `${progress}%`;
        progressBar.textContent = `${Math.round(progress)}%`;
    }
    
    if (messageElement) {
        messageElement.textContent = message;
    }
}

export function closeProgressModal(modal: HTMLDivElement): void {
    if (modal.parentNode) {
        document.body.removeChild(modal);
    }
}

