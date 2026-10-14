export function clampDriveRange(range?: string): string;

export type DriveMediaResult = {
  url: string;
  kind: 'media' | 'preview';
  error?: 'not-public' | 'not-video';
};

export function drivePreviewUrl(fileId: string): string;
export function openDriveFile(fileId: string, range?: string): Promise<Response>;
export function resolveDriveMediaUrl(fileId: string): Promise<DriveMediaResult>;
