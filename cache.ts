import fs from "fs";
import path from "path";
import type { ASTMetadata } from "./parseAST.js";

const CACHE_FILE_NAME = ".corrdex-cache.json";

export interface CacheEntry {
    hash: string;
    ast?: ASTMetadata;
    classification?: any;
}

export interface CacheData {
    files: Record<string, CacheEntry>;
}

export class CorrdexCache {
    private cacheFilePath: string;
    private data: CacheData = { files: {} };
    private isDirty = false;

    constructor(projectRoot: string) {
        this.cacheFilePath = path.join(projectRoot, CACHE_FILE_NAME);
    }

    public load(): void {
        if (!fs.existsSync(this.cacheFilePath)) {
            return;
        }

        try {
            const content = fs.readFileSync(this.cacheFilePath, "utf-8");
            const parsed = JSON.parse(content);
            if (parsed && parsed.files) {
                this.data = parsed;
            }
        } catch (error) {
            console.warn(`Failed to parse cache at ${this.cacheFilePath}, starting fresh.`);
            this.data = { files: {} };
        }
    }

    public exists(): boolean {
        return fs.existsSync(this.cacheFilePath);
    }

    public getCacheFilePath(): string {
        return this.cacheFilePath;
    }

    public getEntryCount(): number {
        return Object.keys(this.data.files).length;
    }

    public get(fileKey: string, currentHash: string): CacheEntry | undefined {
        const entry = this.data.files[fileKey];
        if (entry && entry.hash === currentHash) {
            return entry;
        }
        return undefined;
    }

    public set(fileKey: string, hash: string, ast?: ASTMetadata, classification?: any): void {
        this.data.files[fileKey] = { hash, ast, classification };
        this.isDirty = true;
    }

    public save(): void {
        if (!this.isDirty) {
            return;
        }

        try {
            fs.writeFileSync(this.cacheFilePath, JSON.stringify(this.data, null, 2), "utf-8");
            this.isDirty = false;
        } catch (error) {
            console.error(`Failed to write cache to ${this.cacheFilePath}:`, error);
        }
    }

    public clear(): void {
        this.data = { files: {} };
        this.isDirty = false;

        if (!fs.existsSync(this.cacheFilePath)) {
            return;
        }

        try {
            fs.unlinkSync(this.cacheFilePath);
        } catch (error) {
            console.error(`Failed to clear cache at ${this.cacheFilePath}:`, error);
        }
    }
}
