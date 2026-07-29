import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { updateElectronApp } from 'update-electron-app';

import { state } from './state';
import { carregarCatalogoDeUrls, sincronizarCatalogo } from './holyrics/catalog';
import { prepararEvento } from './holyrics/prepare';
import { executarEvento, itemAnterior, proximoItem } from './holyrics/execute';
import { statusConexao } from './holyrics/healthcheck';
import { criarMusicasPendentes } from './holyrics/pendingSongs';
import {
  ICatalogUrls,
  IConfigurarIntegracaoParams,
  IPendingSong,
  IPrepararEventoParams,
} from './types';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// No-op em dev (app.isPackaged === false); em produção checa releases
// públicas do GitHub e aplica o update automaticamente.
updateElectronApp({ repo: 'pibpam/chruch-admin-electron' });

/**
 * O Electron não hospeda UI própria — a janela carrega a página do admin web
 * (sys-church-fornt), que detecta window.holyricsBridge pra mostrar os
 * controles de Preparar/Executar/Sincronizar (ver docs/integracao-holyrics.md
 * seção 2). Em dev aponta pro Vite local; em produção, pro domínio publicado.
 */
const ADMIN_WEB_URL = process.env.ADMIN_WEB_URL || 'https://admin.pibpam.org';

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(ADMIN_WEB_URL);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
};

// Regra central: o Electron nunca chama o backend, só o Holyrics local e o S3
// com URLs que a própria página já buscou e repassa aqui (ver seção 2 do doc).
ipcMain.handle('holyrics:configurar', async (_event, dados: IConfigurarIntegracaoParams) => {
  state.connection = { token: dados.token, ip: dados.ip, port: dados.port };
  state.alertTemaId = dados.alertTemaId;
  await carregarCatalogoDeUrls(dados.catalogoUrls);
  return { status: 'ok' };
});

ipcMain.handle('holyrics:sincronizar-catalogo', async (_event, urls: ICatalogUrls) => {
  return sincronizarCatalogo(urls);
});

ipcMain.handle('holyrics:preparar', async (_event, params: IPrepararEventoParams) => {
  return prepararEvento(params);
});

ipcMain.handle('holyrics:executar', async (_event, eventId: string) => {
  return executarEvento(eventId);
});

ipcMain.handle('holyrics:next', async () => proximoItem());

ipcMain.handle('holyrics:previous', async () => itemAnterior());

ipcMain.handle('holyrics:criar-pendentes', async (_event, pendentes: IPendingSong[]) => {
  return criarMusicasPendentes(pendentes);
});

ipcMain.handle('holyrics:healthcheck', async () => statusConexao());

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
