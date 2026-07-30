import { IHolyricsConnection, TCatalogFile } from './types';

/**
 * Estado em memória do processo principal — nunca gravado em disco em texto
 * plano (ver docs/integracao-holyrics.md seção 3, sys-church-back). Vive só
 * enquanto a janela do Electron está aberta; configurarIntegracao é chamado
 * de novo a cada sessão pela página.
 */
class HolyricsState {
  connection: IHolyricsConnection | null = null;
  alertTemaId: string | undefined;
  mediaBasePath: string | undefined;
  catalogoLocal: Partial<Record<TCatalogFile, unknown[]>> = {};

  requireConnection(): IHolyricsConnection {
    if (!this.connection) {
      throw new Error('Integração com o Holyrics ainda não foi configurada nesta sessão');
    }
    return this.connection;
  }
}

export const state = new HolyricsState();
