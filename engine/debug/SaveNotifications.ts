/**
 * Utility functions for showing save notifications
 */

export function showSaveNotification(filename: string, success: boolean, s3Url?: string | null, errorMessage?: string): void {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${success ? '#4CAF50' : '#f44336'};
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        font-size: 14px;
        max-width: 400px;
        animation: slideIn 0.3s ease-out;
    `;

    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from {
                transform: translateX(100%);
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
    `;
    document.head.appendChild(style);

    let message = '';
    if (success) {
        message = `✅ ${filename} saved successfully`;
        if (s3Url) {
            message += `<br><small style="opacity: 0.8;">Uploaded to S3</small>`;
        }
    } else {
        message = `❌ Failed to save ${filename}`;
        if (errorMessage) {
            message += `<br><small style="opacity: 0.8;">${errorMessage}</small>`;
        }
    }

    notification.innerHTML = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.transition = 'opacity 0.3s ease-out';
        notification.style.opacity = '0';
        setTimeout(() => {
            if (notification.parentNode) {
                document.body.removeChild(notification);
            }
        }, 300);
    }, success ? 3000 : 5000);
}

export function showVisibilityNotification(success: boolean, data?: any): void {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${success ? '#4CAF50' : '#f44336'};
        color: white;
        padding: 15px 20px;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        z-index: 10000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        font-size: 14px;
        max-width: 400px;
        animation: slideIn 0.3s ease-out;
    `;

    let message = '';
    if (success && data) {
        const cellCount = data.cells?.length || 0;
        const avgVisibleCells = data.avgVisibleCells || 0;
        message = `✅ Visibility data generated<br>`;
        message += `<small style="opacity: 0.8;">Cells: ${cellCount}, Avg visible: ${avgVisibleCells.toFixed(1)}</small>`;
        if (data.s3Url) {
            message += `<br><small style="opacity: 0.8;">Uploaded to S3</small>`;
        }
    } else {
        message = `❌ Failed to generate visibility data`;
    }

    notification.innerHTML = message;
    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.transition = 'opacity 0.3s ease-out';
        notification.style.opacity = '0';
        setTimeout(() => {
            if (notification.parentNode) {
                document.body.removeChild(notification);
            }
        }, 300);
    }, success ? 4000 : 5000);
}

