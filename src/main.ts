import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { updateElectronApp } from 'update-electron-app';

import { state } from './state';
import { carregarCatalogoDeUrls, sincronizarCatalogo } from './holyrics/catalog';
import { prepararEvento } from './holyrics/prepare';
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
 * controles de Preparar/Sincronizar (ver docs/integracao-holyrics.md
 * seção 2). Em dev aponta pro Vite local; em produção, pro domínio publicado.
 */
const ADMIN_WEB_URL = process.env.ADMIN_WEB_URL || 'https://admin.pibpam.org';

/**
 * A página vem do S3 e o Chromium guarda index.html/assets em cache (inclusive por
 * heurística, quando o S3 não manda Cache-Control), então um deploy novo só aparecia
 * depois de limpar o cache na mão. Ao abrir o app, descarta o cache HTTP, service
 * workers e Cache Storage — cookies e localStorage ficam, pra não perder o login — e
 * marca toda resposta do domínio do admin como no-store, pra reload também buscar de novo.
 */
const ignorarCacheDaPagina = async () => {
  const { origin } = new URL(ADMIN_WEB_URL);

  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData({
    storages: ['serviceworkers', 'cachestorage'],
  });

  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    const headers = Object.fromEntries(
      Object.entries(details.responseHeaders ?? {}).filter(
        ([nome]) => !['cache-control', 'expires', 'etag', 'last-modified'].includes(nome.toLowerCase()),
      ),
    );
    headers['Cache-Control'] = ['no-store'];
    callback({ responseHeaders: headers });
  });
};

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
  state.mediaBasePath = dados.mediaBasePath;
  await carregarCatalogoDeUrls(dados.catalogoUrls);
  return { status: 'ok' };
});

ipcMain.handle('holyrics:sincronizar-catalogo', async (_event, urls: ICatalogUrls) => {
  return sincronizarCatalogo(urls);
});

ipcMain.handle('holyrics:preparar', async (event, params: IPrepararEventoParams) => {
  return prepararEvento(params, (progresso) => {
    if (!event.sender.isDestroyed()) event.sender.send('holyrics:preparar:progresso', progresso);
  });
});

ipcMain.handle('holyrics:criar-pendentes', async (_event, pendentes: IPendingSong[]) => {
  return criarMusicasPendentes(pendentes);
});

ipcMain.handle('holyrics:healthcheck', async () => statusConexao());

// Versão do próprio app (package.json, via Electron), não do Holyrics — pra página web
// conseguir mostrar qual build está rodando no computador da igreja (ver auto-update).
ipcMain.handle('app:versao', () => app.getVersion());

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  await ignorarCacheDaPagina();
  createWindow();
});

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
