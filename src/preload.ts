import { contextBridge, ipcRenderer } from 'electron';
import {
  IConfigurarIntegracaoParams,
  ICatalogUrls,
  ICriarMusicaPendenteResult,
  IHealthcheckResult,
  IPendingSong,
  IPrepararEventoParams,
  IPrepararEventoResult,
} from './types';

/**
 * Ponte exposta pra página do admin web (ver docs/integracao-holyrics.md
 * seção 2). contextIsolation habilitado — a página só enxerga essas funções,
 * nunca o Node/Electron por trás delas.
 */
contextBridge.exposeInMainWorld('holyricsBridge', {
  configurarIntegracao: (dados: IConfigurarIntegracaoParams): Promise<{ status: string }> =>
    ipcRenderer.invoke('holyrics:configurar', dados),

  sincronizarCatalogo: (urlsUpload: ICatalogUrls): Promise<{ status: string }> =>
    ipcRenderer.invoke('holyrics:sincronizar-catalogo', urlsUpload),

  prepararEvento: (params: IPrepararEventoParams): Promise<IPrepararEventoResult> =>
    ipcRenderer.invoke('holyrics:preparar', params),

  criarMusicasPendentes: (pendentes: IPendingSong[]): Promise<ICriarMusicaPendenteResult[]> =>
    ipcRenderer.invoke('holyrics:criar-pendentes', pendentes),

  statusConexao: (): Promise<IHealthcheckResult> => ipcRenderer.invoke('holyrics:healthcheck'),

  getVersaoApp: (): Promise<string> => ipcRenderer.invoke('app:versao'),
});
