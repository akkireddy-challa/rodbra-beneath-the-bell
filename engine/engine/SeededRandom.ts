export class SeededRandom {
    private seed: number;
    private state: number;

    constructor(seed: number) {
        this.seed = seed;
        this.state = seed;
    }

    next(): number {
        // Linear congruential generator (simple but effective for world generation)
        this.state = (this.state * 1664525 + 1013904223) % 4294967296;
        return this.state / 4294967296; // Convert to 0-1 range
    }

    nextInRange(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    nextInt(max: number): number {
        return Math.floor(this.next() * max);
    }

    reset(): void {
        this.state = this.seed;
    }

    setSeed(newSeed: number): void {
        this.seed = newSeed;
        this.state = newSeed;
    }

    getSeed(): number {
        return this.seed;
    }
}