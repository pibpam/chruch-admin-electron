import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import {
  IConfigurarIntegracaoParams,
  ICatalogUrls,
  ICriarMusicaPendenteResult,
  IHealthcheckResult,
  IPendingSong,
  IPrepararEventoParams,
  IPrepararEventoResult,
  IPrepararProgresso,
  IPreparacaoStatus,
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

  /** Passos da preparação em tempo real — devolve a função pra parar de escutar. */
  onPrepararProgresso: (callback: (progresso: IPrepararProgresso) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, progresso: IPrepararProgresso) => callback(progresso);
    ipcRenderer.on('holyrics:preparar:progresso', listener);
    return () => ipcRenderer.removeListener('holyrics:preparar:progresso', listener);
  },

  /** Preparação em andamento/terminada no processo principal — sobrevive a reload da página. */
  statusPreparacao: (): Promise<IPreparacaoStatus | null> => ipcRenderer.invoke('holyrics:preparar:status'),

  aguardarPreparacao: (): Promise<IPrepararEventoResult> => ipcRenderer.invoke('holyrics:preparar:aguardar'),

  descartarPreparacao: (planUuid: string): Promise<void> => ipcRenderer.invoke('holyrics:preparar:descartar', planUuid),

  criarMusicasPendentes: (pendentes: IPendingSong[]): Promise<ICriarMusicaPendenteResult[]> =>
    ipcRenderer.invoke('holyrics:criar-pendentes', pendentes),

  statusConexao: (): Promise<IHealthcheckResult> => ipcRenderer.invoke('holyrics:healthcheck'),

  getVersaoApp: (): Promise<string> => ipcRenderer.invoke('app:versao'),

  getNomeComputador: (): Promise<string> => ipcRenderer.invoke('app:nome-computador'),
});
