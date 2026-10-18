import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, MessageBoxOptions, session } from 'electron';
import os from 'node:os';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { updateElectronApp } from 'update-electron-app';

import { state } from './state';
import { carregarCatalogoDeUrls, sincronizarCatalogo } from './holyrics/catalog';
import {
  aguardarPreparacao,
  descartarPreparacao,
  iniciarPreparacao,
  statusPreparacao,
} from './holyrics/preparacaoAtual';
import { statusConexao } from './holyrics/healthcheck';
import { criarMusicasPendentes, editarMusica } from './holyrics/pendingSongs';
import { criarBandeja, mostrar } from './tray';
import {
  ICatalogUrls,
  IConfigurarIntegracaoParams,
  IEditarMusicaParams,
  IPendingSong,
  IPrepararEventoParams,
} from './types';

// Abre a janela escondida (só na bandeja) — usado quando o app sobe junto com o Windows.
const ARG_OCULTO = '--oculto';
// Pede pra instância que já está rodando encerrar — usado pela tarefa da barra de tarefas.
const ARG_ENCERRAR = '--encerrar';

/**
 * No Windows (Squirrel) o login item precisa apontar pro launcher da raiz
 * (%LocalAppData%\ChurchAdmin\ChurchAdmin.exe), que repassa os argumentos pra versão
 * atual; o process.execPath fica em app-x.y.z e muda a cada update.
 */
const loginItemPath = () =>
  process.platform === 'win32'
    ? { path: path.resolve(path.dirname(process.execPath), '..', path.basename(process.execPath)) }
    : {};

// Ao desinstalar, tira o app da inicialização do Windows.
if (process.argv.includes('--squirrel-uninstall')) {
  app.setLoginItemSettings({ openAtLogin: false, ...loginItemPath() });
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Uma instância só: abrir de novo (atalho, login, tarefa da barra) fala com a que já roda.
const instanciaUnica = app.requestSingleInstanceLock();
if (!instanciaUnica) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

// Fechar a janela só esconde pra bandeja; o app sai de verdade só quando isso é true.
let encerrando = false;
const encerrar = () => {
  encerrando = true;
  app.quit();
};
app.on('before-quit', () => {
  encerrando = true;
});
// O update automático fecha as janelas antes do before-quit, então marca aqui também.
autoUpdater.on('before-quit-for-update', () => {
  encerrando = true;
});

// Versões em que a pessoa escolheu "Depois" — o update-electron-app checa de novo a cada 10 min e
// baixa de novo, então sem isso o aviso voltaria toda vez. Aplica sozinho ao reabrir o app.
const atualizacoesAdiadas = new Set<string>();
let avisoAtualizacaoAberto = false;

/** Aviso de update baixado, pedindo pra reiniciar — no lugar do diálogo padrão (em inglês). */
async function avisarAtualizacao(releaseName?: string) {
  const versao = (releaseName || '').replace(/^v/, '');
  if (avisoAtualizacaoAberto || atualizacoesAdiadas.has(versao)) return;
  avisoAtualizacaoAberto = true;

  // Reiniciar no meio da preparação interromperia a montagem da playlist no Holyrics.
  const preparando = statusPreparacao()?.status === 'running';
  const opcoes: MessageBoxOptions = {
    type: 'info',
    title: 'Atualização disponível',
    message: versao
      ? `A versão ${versao} do ChurchAdmin foi baixada.`
      : 'Uma nova versão do ChurchAdmin foi baixada.',
    detail: preparando
      ? 'Tem uma preparação de culto em andamento. Espere ela terminar para reiniciar, ou deixe para depois: a atualização é aplicada na próxima vez que o app abrir.'
      : 'Reinicie o app para usar a versão nova. Se deixar para depois, a atualização é aplicada na próxima vez que o app abrir.',
    buttons: ['Reiniciar agora', 'Depois'],
    defaultId: preparando ? 1 : 0,
    cancelId: 1,
    noLink: true,
  };

  try {
    // Com a janela escondida na bandeja, o diálogo abre sozinho (preso a ela, ficaria invisível).
    const janela = mainWindow?.isVisible() ? mainWindow : null;
    const { response } = janela
      ? await dialog.showMessageBox(janela, opcoes)
      : await dialog.showMessageBox(opcoes);
    if (response === 0) autoUpdater.quitAndInstall();
    else atualizacoesAdiadas.add(versao);
  } finally {
    avisoAtualizacaoAberto = false;
  }
}

// No-op em dev (app.isPackaged === false); em produção checa releases públicas do GitHub,
// baixa o update e pergunta se quer reiniciar (ver avisarAtualizacao).
updateElectronApp({
  repo: 'pibpam/chruch-admin-electron',
  onNotifyUser: ({ releaseName }) => {
    void avisarAtualizacao(releaseName);
  },
});

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

const createWindow = (oculta: boolean) => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: !oculta,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A página continua chamando o Holyrics com a janela escondida na bandeja.
      backgroundThrottling: false,
    },
  });

  mainWindow.on('close', (event) => {
    if (encerrando) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
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

ipcMain.handle('holyrics:preparar', async (_event, params: IPrepararEventoParams) => iniciarPreparacao(params));

// Reconexão depois de um reload da página no meio da preparação (ver preparacaoAtual.ts).
ipcMain.handle('holyrics:preparar:status', () => statusPreparacao());
ipcMain.handle('holyrics:preparar:aguardar', () => aguardarPreparacao());
ipcMain.handle('holyrics:preparar:descartar', (_event, planUuid: string) => descartarPreparacao(planUuid));

ipcMain.handle('holyrics:criar-pendentes', async (_event, pendentes: IPendingSong[]) => {
  return criarMusicasPendentes(pendentes);
});

ipcMain.handle('holyrics:editar-musica', async (_event, edicao: IEditarMusicaParams) => editarMusica(edicao));

ipcMain.handle('holyrics:healthcheck', async () => statusConexao());

// Versão do próprio app (package.json, via Electron), não do Holyrics — pra página web
// conseguir mostrar qual build está rodando no computador da igreja (ver auto-update).
ipcMain.handle('app:versao', () => app.getVersion());

// Nome do computador — identifica este app na lista da preparação remota do admin web.
ipcMain.handle('app:nome-computador', () => os.hostname());

const criarMenu = () => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Arquivo',
        submenu: [
          { label: 'Fechar janela', accelerator: 'CmdOrCtrl+W', click: () => mainWindow?.hide() },
          { type: 'separator' },
          { label: 'Encerrar', accelerator: 'CmdOrCtrl+Q', click: encerrar },
        ],
      },
      { role: 'editMenu', label: 'Editar' },
      { role: 'viewMenu', label: 'Exibir' },
    ]),
  );
};

// Botão direito no ícone da barra de tarefas do Windows → "Encerrar ChurchAdmin".
// Abre uma segunda instância com --encerrar, que cai no second-instance abaixo.
const criarTarefasDaBarra = () => {
  if (process.platform !== 'win32') return;
  app.setUserTasks([
    {
      program: process.execPath,
      arguments: ARG_ENCERRAR,
      iconPath: process.execPath,
      iconIndex: 0,
      title: 'Encerrar ChurchAdmin',
      description: 'Fecha o ChurchAdmin, inclusive da bandeja',
    },
  ]);
};

app.on('second-instance', (_event, argv) => {
  if (argv.includes(ARG_ENCERRAR)) encerrar();
  else mostrar(mainWindow);
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
  if (started || !instanciaUnica) return;
  // Pediu pra encerrar mas não havia nada rodando: não abre nada.
  if (process.argv.includes(ARG_ENCERRAR)) {
    app.quit();
    return;
  }

  // Sobe junto com o sistema, já escondido na bandeja. Em dev não mexe no login.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, args: [ARG_OCULTO], ...loginItemPath() });
  }

  criarMenu();
  criarTarefasDaBarra();
  criarBandeja(() => mostrar(mainWindow), encerrar);

  await ignorarCacheDaPagina();
  createWindow(process.argv.includes(ARG_OCULTO));
});

// O app vive na bandeja: sem janela visível ele continua rodando até "Encerrar".
app.on('window-all-closed', () => undefined);

app.on('activate', () => {
  if (mainWindow) mostrar(mainWindow);
  else createWindow(false);
});
