export const VIDEO_QUEUE = 'video-processing';
export const CLIP_EXPORT_QUEUE = 'clip-export';

export enum VideoJobType {
  DOWNLOAD_YOUTUBE = 'download-youtube',
  PROCESS_UPLOADED = 'process-uploaded',
}

export enum ClipJobType {
  EXPORT_CLIP = 'export-clip',
  CLEANUP_TEMP = 'cleanup-temp',
}
