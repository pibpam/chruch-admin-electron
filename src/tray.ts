import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import path from 'node:path';

// Guardado em módulo pra não ser coletado pelo GC (o ícone some da bandeja).
let tray: Tray | null = null;

const caminhoIcone = () => {
  const arquivo = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  // Empacotado, vem do extraResource do forge.config.ts; em dev, direto de assets/.
  return app.isPackaged
    ? path.join(process.resourcesPath, arquivo)
    : path.join(app.getAppPath(), 'assets', arquivo);
};

export const criarBandeja = (mostrarJanela: () => void, encerrar: () => void) => {
  const icone = nativeImage.createFromPath(caminhoIcone()).resize({ width: 16, height: 16 });
  tray = new Tray(icone);
  tray.setToolTip('ChurchAdmin');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir ChurchAdmin', click: mostrarJanela },
      { type: 'separator' },
      { label: 'Encerrar', click: encerrar },
    ]),
  );
  tray.on('click', mostrarJanela);
  tray.on('double-click', mostrarJanela);
};

export const mostrar = (janela: BrowserWindow | null) => {
  if (!janela) return;
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.focus();
};
