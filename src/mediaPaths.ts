import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Pasta local onde o Electron salva os assets baixados do S3, organizados por
 * tipo — precisa ser a MESMA pasta configurada dentro do Holyrics (Menu
 * arquivo > Configurações > pastas de mídia) pra cada aba (áudio/vídeo/
 * imagem/arquivo), já que o Holyrics resolve um item por nome de arquivo
 * dentro da pasta que ele mesmo tem configurada — a API não expõe esse
 * caminho, então é combinado manualmente uma vez na configuração da máquina.
 * Convenção: C:\holyrics\base-midia\<tipo>, sobrescrevível via
 * HOLYRICS_MEDIA_BASE_PATH.
 */
const BASE_PATH = process.env.HOLYRICS_MEDIA_BASE_PATH || 'C:\\holyrics\\base-midia';

const FOLDER_BY_TYPE: Record<string, string> = {
  audio: 'audio',
  video: 'video',
  image: 'image',
  file: 'file',
  automatic_presentation: 'automatic_presentation',
};

export function getMediaFolder(type: string): string {
  const folder = FOLDER_BY_TYPE[type];
  if (!folder) throw new Error(`Tipo de mídia sem pasta configurada: ${type}`);
  return path.join(BASE_PATH, folder);
}

export async function getMediaFilePath(type: string, fileName: string): Promise<string> {
  const folder = getMediaFolder(type);
  await fs.mkdir(folder, { recursive: true });
  return path.join(folder, fileName);
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
