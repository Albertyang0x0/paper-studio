export interface SourceFile { path: string; bytes: Buffer }
export function isPrivatePath(path: string): boolean;
export function isSourcePath(path: string): boolean;
export function collectSourceFiles(root: string): Promise<SourceFile[]>;
export function scanForCredentials(files: SourceFile[], knownSecrets?: string[]): void;
