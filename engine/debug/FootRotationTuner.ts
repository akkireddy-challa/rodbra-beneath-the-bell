import { BlockCharacterRenderer } from '../engine/BlockCharacterRenderer.js';

/**
 * Debug UI for live-tuning foot rotations
 * Press F3 to toggle the tuning panel
 */
export class FootRotationTuner {
    private panel: HTMLDivElement | null = null;
    private visible: boolean = true; // Start visible for debugging

    constructor() {
        console.log('FootRotationTuner: Initializing...');
        // Defer panel creation until DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                this.createPanel();
                this.setupKeyboardToggle();
            });
        } else {
            this.createPanel();
            this.setupKeyboardToggle();
        }
        console.log('FootRotationTuner: Constructor complete');
    }

    private createPanel(): void {
        console.log('FootRotationTuner: Creating panel...');
        // Create panel container
        this.panel = document.createElement('div');
        this.panel.id = 'foot-rotation-tuner';
        this.panel.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            background: rgba(0, 0, 0, 0.85);
            color: white;
            padding: 20px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 12px;
            z-index: 10000;
            display: block;
            min-width: 320px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
        `;
        console.log('FootRotationTuner: Panel element created');

        // Title
        const title = document.createElement('div');
        title.textContent = 'Foot Rotation Tuner';
        title.style.cssText = `
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 15px;
            color: #4CAF50;
            border-bottom: 1px solid #4CAF50;
            padding-bottom: 8px;
        `;
        this.panel.appendChild(title);

        // Instructions
        const instructions = document.createElement('div');
        instructions.textContent = 'Press F3 to toggle | Adjust sliders in real-time';
        instructions.style.cssText = `
            font-size: 10px;
            color: #888;
            margin-bottom: 15px;
        `;
        this.panel.appendChild(instructions);

        // Create sliders for each rotation parameter
        this.createSlider('baseY', 'Base Y-Axis (Both)', -180, 180, 1);
        
        // Separator
        const leftSeparator = document.createElement('div');
        leftSeparator.textContent = '─── Left Foot ───';
        leftSeparator.style.cssText = 'color: #4CAF50; text-align: center; margin: 15px 0 10px 0; font-weight: bold;';
        this.panel!.appendChild(leftSeparator);
        
        this.createSlider('leftX', 'Left X-Axis', -180, 180, 1);
        this.createSlider('leftY', 'Left Y-Axis', -180, 180, 1);
        this.createSlider('leftZ', 'Left Z-Axis', -180, 180, 1);
        
        // Separator
        const rightSeparator = document.createElement('div');
        rightSeparator.textContent = '─── Right Foot ───';
        rightSeparator.style.cssText = 'color: #4CAF50; text-align: center; margin: 15px 0 10px 0; font-weight: bold;';
        this.panel!.appendChild(rightSeparator);
        
        this.createSlider('rightX', 'Right X-Axis', -180, 180, 1);
        this.createSlider('rightY', 'Right Y-Axis', -180, 180, 1);
        this.createSlider('rightZ', 'Right Z-Axis', -180, 180, 1);

        // Copy values button
        const copyButton = document.createElement('button');
        copyButton.textContent = 'Copy Values to Console';
        copyButton.style.cssText = `
            width: 100%;
            padding: 8px;
            margin-top: 15px;
            background: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-family: monospace;
        `;
        copyButton.onclick = () => this.copyValues();
        this.panel.appendChild(copyButton);

        document.body.appendChild(this.panel);
        console.log('FootRotationTuner: Panel appended to document.body');
        console.log('FootRotationTuner: Panel display style:', this.panel.style.display);
        console.log('FootRotationTuner: Panel is in DOM:', document.body.contains(this.panel));
    }

    private createSlider(key: keyof typeof BlockCharacterRenderer.footRotationTuning, label: string, min: number, max: number, step: number): void {
        if (!this.panel) {
            console.warn('FootRotationTuner: Cannot create slider, panel is null');
            return;
        }

        console.log(`FootRotationTuner: Creating slider for ${key}`);
        const container = document.createElement('div');
        container.style.cssText = `
            margin-bottom: 15px;
        `;

        // Label with current value
        const labelDiv = document.createElement('div');
        labelDiv.style.cssText = `
            display: flex;
            justify-content: space-between;
            margin-bottom: 5px;
        `;
        
        const labelText = document.createElement('span');
        labelText.textContent = label;
        labelText.style.color = '#ddd';
        
        const valueDisplay = document.createElement('span');
        valueDisplay.id = `value-${key}`;
        valueDisplay.textContent = `${BlockCharacterRenderer.footRotationTuning[key]}°`;
        valueDisplay.style.cssText = `
            color: #4CAF50;
            font-weight: bold;
        `;
        
        labelDiv.appendChild(labelText);
        labelDiv.appendChild(valueDisplay);
        container.appendChild(labelDiv);

        // Slider
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = min.toString();
        slider.max = max.toString();
        slider.step = step.toString();
        slider.value = BlockCharacterRenderer.footRotationTuning[key].toString();
        slider.style.cssText = `
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: #333;
            outline: none;
            -webkit-appearance: none;
        `;

        // Slider thumb styling
        const style = document.createElement('style');
        style.textContent = `
            input[type=range]::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: #4CAF50;
                cursor: pointer;
            }
            input[type=range]::-moz-range-thumb {
                width: 16px;
                height: 16px;
                border-radius: 50%;
                background: #4CAF50;
                cursor: pointer;
                border: none;
            }
        `;
        document.head.appendChild(style);

        slider.oninput = () => {
            const value = parseFloat(slider.value);
            BlockCharacterRenderer.footRotationTuning[key] = value;
            valueDisplay.textContent = `${value}°`;
        };

        container.appendChild(slider);
        this.panel!.appendChild(container);
    }

    private setupKeyboardToggle(): void {
        window.addEventListener('keydown', (e) => {
            if (e.key === 'F3') {
                e.preventDefault();
                this.toggle();
            }
        });
    }

    private toggle(): void {
        if (!this.panel) return;
        this.visible = !this.visible;
        this.panel.style.display = this.visible ? 'block' : 'none';
        console.log(`Foot Rotation Tuner: ${this.visible ? 'ENABLED' : 'DISABLED'}`);
    }

    private copyValues(): void {
        const tuning = BlockCharacterRenderer.footRotationTuning;
        const output = `
Foot Rotation Values:
--------------------
baseY:  ${tuning.baseY}
leftX:  ${tuning.leftX}
leftY:  ${tuning.leftY}
leftZ:  ${tuning.leftZ}
rightX: ${tuning.rightX}
rightY: ${tuning.rightY}
rightZ: ${tuning.rightZ}

Code format:
BlockCharacterRenderer.footRotationTuning = {
    baseY: ${tuning.baseY},
    leftX: ${tuning.leftX},
    leftY: ${tuning.leftY},
    leftZ: ${tuning.leftZ},
    rightX: ${tuning.rightX},
    rightY: ${tuning.rightY},
    rightZ: ${tuning.rightZ}
};
        `.trim();
        
        console.log(output);
        alert('Values copied to console! Check the developer console (F12)');
    }

    public dispose(): void {
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
        }
    }
}

