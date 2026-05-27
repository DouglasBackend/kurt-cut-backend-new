import * as path from 'path';

/**
 * Sanitizes a file path to be used as a public URL relative to the /uploads route.
 * Converts absolute local paths (e.g., C:\Projetos\...\uploads\file.mp4) 
 * into public URLs (e.g., uploads/file.mp4).
 */
export function sanitizePath(filePath: string): string {
  if (!filePath) return filePath;
  
  // Normalize path to use forward slashes
  const normalized = filePath.replace(/\\/g, '/');
  
  // Find "uploads/" in the path
  const uploadsSegment = 'uploads/';
  const uploadsIndex = normalized.lastIndexOf(uploadsSegment);
  
  if (uploadsIndex !== -1) {
    // Return path starting from "uploads/"
    return normalized.substring(uploadsIndex);
  }
  
  // If "uploads/" not found but seems relative, ensure it starts with it
  const basename = path.basename(normalized);
  return `uploads/${basename}`;
}
