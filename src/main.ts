import { exec } from 'child_process';
import * as chokidar from 'chokidar';
import { app, BrowserWindow, Display, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { CursorTypeDetector } from './cursor_type_detector';
import { RawInputMouseDetector } from './raw_input_detector';
import { AppConfig, MouseDevice, MouseMoveData } from './types';

if (process.platform === 'win32') {
  exec('chcp 65001');
}

const addon = require(path.join(__dirname, '..', 'bin', 'win32-x64-116', 'Orionix.node'));

const DEFAULT_CONFIG: AppConfig = {
  sensitivity: 1.5,
  refreshRate: 1,
  maxCursors: 4,
  cursorSize: 20,
  cursorColors: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'],
  highPerformanceMode: true,
  precisePositioning: true,
  allowTrayLeftClick: false,

  colorIdentification: true,
  cursorOpacity: 1.0,
  cursorSpeed: 1.0,
  acceleration: true,
  overlayDebug: false,
};

interface CursorState {
  id: string;
  deviceName: string;
  deviceHandle: string | number;
  x: number;
  y: number;
  color: string;
  lastUpdate: number;
  isRawInput: boolean;
  cursorType: string;
  cursorCSS: string;
  cursorFile: string;
  hasMovedOnce: boolean;
  totalMovement: number;
}

class OrionixAppElectron {
  private overlayWindows: Map<number, BrowserWindow> = new Map();
  private settingsWindow: BrowserWindow | null = null;
  private config: AppConfig = { ...DEFAULT_CONFIG };
  private configPath: string;
  private cursors: Map<string, CursorState> = new Map();
  private isShuttingDown: boolean = false;
  private lastActiveDevice: string | null = null;

  private screenWidth: number = 800;
  private screenHeight: number = 600;

  private fullScreenWidth: number = 800;

  private fullScreenHeight: number = 600;
  private centerX: number;
  private centerY: number;

  private calibrationRatioX: number = 1.0;

  private calibrationRatioY: number = 1.0;

  private correctionFactorX: number = 1.0;

  private correctionFactorY: number = 1.0;

  private lastRenderTime: number = 0;
  private targetFPS: number = 1000;
  private frameInterval: number;
  private renderRequestId: NodeJS.Immediate | null = null;
  private highPrecisionTimer: NodeJS.Timeout | null = null;

  private lastSystemCursorPos: { x: number; y: number } = { x: 0, y: 0 };
  private systemCursorUpdatePending: boolean = false;

  private lastLogTime: number = 0;
  private logThrottle: number = 2000;

  private mouseDetector: RawInputMouseDetector;
  private cursorTypeDetector: CursorTypeDetector;
  private fileWatcher?: chokidar.FSWatcher;
  private tray: Tray | null = null;

  private allowTrayLeftClick: boolean = false;
  private cursorHidden: boolean = false;
  private periodicExportTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.configPath = path.join(__dirname, '..', 'config.json');
    this.centerX = this.screenWidth / 2;
    this.centerY = this.screenHeight / 2;
    this.frameInterval = 1000 / this.targetFPS;

    this.mouseDetector = new RawInputMouseDetector();
    this.cursorTypeDetector = new CursorTypeDetector();

    console.log('Initialisation du gestionnaire de curseur système...');
    try {
      const addon = require(path.join(__dirname, '..', 'bin', 'win32-x64-116', 'Orionix.node'));

      try {
        const shutdownHandlerResult = addon.setupShutdownHandler();
        console.log('Gestionnaire de fermeture Windows activé:', shutdownHandlerResult);
      } catch (handlerError) {
        console.warn("Impossible d'activer le gestionnaire de fermeture Windows:", handlerError);
      }

      const initialCursorState = addon.getCursorState();
      console.log('État initial du curseur:', initialCursorState.type);
    } catch (error) {
      console.error('Erreur lors du masquage du curseur système:', error);
      this.cursorHidden = false;
    }

    this.setupMouseEvents();
    this.setupCursorTypeEvents();
    this.loadConfig();

    this.allowTrayLeftClick = !!this.config.allowTrayLeftClick;
    this.setupAppEvents();
    this.setupFileWatcher();
    this.initHighPerformanceLoop();
    this.startPeriodicCursorExport();
    this.setupSettingsIPC();
  }

  private initHighPerformanceLoop(): void {
    if (this.config.highPerformanceMode) {
      this.startHighPrecisionRendering();
    }
  }

  private manageSystemCursorVisibility(): void {
    const hasActiveCursors = this.cursors.size > 0;

    if (hasActiveCursors && !this.cursorHidden) {
      console.log('Masquage du curseur système (curseurs actifs détectés)...');
      try {
        const addon = require(path.join(__dirname, '..', 'bin', 'win32-x64-116', 'Orionix.node'));
        const hideResult = addon.hideSystemCursor();
        this.cursorHidden = hideResult || false;
        console.log('Curseur système masqué:', hideResult);
      } catch (error) {
        console.warn('Erreur lors du masquage du curseur système:', error);
      }
    } else if (!hasActiveCursors && this.cursorHidden) {
      console.log('Restauration du curseur système (aucun curseur actif)...');
      try {
        const addon = require(path.join(__dirname, '..', 'bin', 'win32-x64-116', 'Orionix.node'));
        const showResult = addon.showSystemCursor();
        if (showResult) {
          this.cursorHidden = false;
          console.log('Curseur système restauré:', showResult);
        } else {
          console.warn('Échec de la restauration du curseur système');
        }
      } catch (error) {
        console.warn('Erreur lors de la restauration du curseur système:', error);
      }
    }
  }

  private startHighPrecisionRendering(): void {
    const render = (): void => {
      const now = performance.now();
      if (now - this.lastRenderTime >= this.frameInterval) {
        this.lastRenderTime = now;
        this.updateCursorPositionsHighPrecision();
      }

      if (!this.isShuttingDown) {
        this.renderRequestId = setImmediate(render);
      }
    };

    this.renderRequestId = setImmediate(render);
  }

  private updateCursorPositionsHighPrecision(): void {
    if (this.lastActiveDevice && this.cursors.has(this.lastActiveDevice)) {
      const cursor = this.cursors.get(this.lastActiveDevice)!;
      this.syncSystemCursorToHTML(cursor);
    }

    this.updateOverlayInstantly();
  }

  private syncSystemCursorToHTML(cursor: CursorState): void {
    if (!this.systemCursorUpdatePending) {
      this.systemCursorUpdatePending = true;

      setImmediate(() => {
        const systemCoords = this.convertHTMLToSystemCoordinates(cursor.x, cursor.y);
        const targetX = Math.round(systemCoords.x);
        const targetY = Math.round(systemCoords.y);

        if (Math.abs(this.lastSystemCursorPos.x - targetX) > 0 || Math.abs(this.lastSystemCursorPos.y - targetY) > 0) {
          if (this.mouseDetector.rawInputModule?.setSystemCursorPos) {
            this.mouseDetector.rawInputModule.setSystemCursorPos(targetX, targetY);
            this.lastSystemCursorPos = { x: targetX, y: targetY };
          }
        }

        this.systemCursorUpdatePending = false;
      });
    }
  }

  private updateOverlayInstantly(): void {
    const activeCursors = Array.from(this.cursors.values())
      .filter((c) => c.hasMovedOnce)
      .map((c) => ({
        deviceId: c.id,
        deviceName: c.deviceName,
        deviceHandle: c.deviceHandle,
        x: c.x,
        y: c.y,
        color: c.color,
        isRawInput: c.isRawInput,
        cursorType: c.cursorType,
        cursorCSS: c.cursorCSS,
        cursorFile: c.cursorFile,
        isVisible: true,
      }));

    const now = Date.now();
    if (activeCursors.length > 0 && now - this.lastLogTime > this.logThrottle) {
      activeCursors.forEach((c) => {});
      this.lastLogTime = now;
    }

    this.sendToAllOverlays('cursors-instant-update', {
      cursors: activeCursors,
      lastActiveDevice: this.lastActiveDevice,
      timestamp: performance.now(),
    });
  }

  private setupFileWatcher(): void {
    const filesToWatch = [path.join(__dirname, '..', 'overlay.css'), path.join(__dirname, '..', 'overlay.html'), path.join(__dirname, 'renderer.js'), path.join(__dirname, '..', 'cursorsToUse.json')];

    this.fileWatcher = chokidar.watch(filesToWatch, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
    });

    this.fileWatcher.on('change', (filePath: string) => {
      if (filePath.endsWith('cursorsToUse.json')) {
        console.log('cursorsToUse.json modifié - rechargement des mappings de curseurs...');
        this.sendToAllOverlays('cursors-config-changed', {});

        setTimeout(() => {
          this.cursors.forEach((cursor, deviceId) => {
            this.sendToAllOverlays('cursor-updated', cursor);
          });
        }, 500);
      }
      this.overlayWindows.forEach((window) => {
        if (window && !window.isDestroyed()) {
          window.webContents.reload();
        }
      });
    });
  }

  private setupMouseEvents(): void {
    this.mouseDetector.on('deviceAdded', (device: MouseDevice) => {
      console.log(`=== DEVICE ADDED ===`);
      console.log(`Device ID: ${device.id}, Name: ${device.name}`);
      this.updateDeviceDisplay();
    });

    this.mouseDetector.on('deviceRemoved', (device: MouseDevice) => {
      console.log(`=== DEVICE REMOVED ===`);
      console.log(`Device ID: ${device.id}, Name: ${device.name}`);
      console.log(`Suppression du curseur associé...`);
      this.removeCursor(device.id);
      this.updateDeviceDisplay();
    });

    this.mouseDetector.on('mouseMove', (data: MouseMoveData) => {
      this.handleMouseMove(data);
    });

    this.mouseDetector.on('started', () => {});
    this.mouseDetector.on('stopped', () => {});
  }

  private setupCursorTypeEvents(): void {
    this.cursorTypeDetector.onCursorChange((newType: string) => {
      if (this.lastActiveDevice && this.cursors.has(this.lastActiveDevice)) {
        const cursor = this.cursors.get(this.lastActiveDevice)!;
        cursor.cursorType = newType;
        cursor.cursorCSS = this.cursorTypeDetector.getCursorCSS(newType);
        cursor.cursorFile = this.cursorTypeDetector.getCursorFile(newType);
      }

      this.sendToAllOverlays('cursor-type-changed', {
        type: newType,
        cssClass: this.cursorTypeDetector.getCursorCSS(newType),
        file: this.cursorTypeDetector.getCursorFile(newType),
        filePath: this.cursorTypeDetector.getCursorFilePath(newType),
        activeDeviceId: this.lastActiveDevice,
      });
    });
  }

  private setupAppEvents(): void {
    app.whenReady().then(async () => {
      const primaryDisplay: Display = screen.getPrimaryDisplay();
      this.screenWidth = primaryDisplay.size.width;
      this.screenHeight = primaryDisplay.size.height;
      this.fullScreenWidth = primaryDisplay.size.width;
      this.fullScreenHeight = primaryDisplay.size.height;
      this.centerX = this.screenWidth / 2;
      this.centerY = this.screenHeight / 2;

      try {
        await this.exportCursors();
      } catch (error) {
        console.warn("Impossible d'exporter les curseurs au démarrage:", error);
      }

      this.calibrateCoordinateMapping();
      this.startMouseInput();
      this.createOverlayWindows();
      this.createTray();
      this.setupIPC();
      this.setupGlobalShortcuts();

      Menu.setApplicationMenu(null);

      screen.on('display-metrics-changed', () => {
        this.updateScreenDimensions();
      });

      screen.on('display-added', () => {
        this.updateScreenDimensions();
      });

      screen.on('display-removed', () => {
        this.updateScreenDimensions();
      });
    });

    app.on('window-all-closed', () => {
      this.shutdown();
    });

    app.on('before-quit', () => {
      this.saveConfig();
    });
  }

  private updateScreenDimensions(): void {
    const primaryDisplay: Display = screen.getPrimaryDisplay();
    const newWidth = primaryDisplay.size.width;
    const newHeight = primaryDisplay.size.height;

    if (this.screenWidth !== newWidth || this.screenHeight !== newHeight) {
      this.screenWidth = newWidth;
      this.screenHeight = newHeight;
      this.centerX = this.screenWidth / 2;
      this.centerY = this.screenHeight / 2;

      setTimeout(() => {
        this.createOverlayWindows();
      }, 100);

      this.sendToAllOverlays('screen-dimensions-changed', {
        width: this.screenWidth,
        height: this.screenHeight,
        centerX: this.centerX,
        centerY: this.centerY,
      });
    }
  }

  private async calibrateCoordinateMapping(): Promise<void> {
    try {
      let currentSystemPos = null;
      if (this.mouseDetector.rawInputModule?.getSystemCursorPos) {
        currentSystemPos = this.mouseDetector.rawInputModule.getSystemCursorPos();
      } else {
        currentSystemPos = screen.getCursorScreenPoint();
      }

      if (currentSystemPos) {
        this.calibrationRatioX = 1.0;
        this.calibrationRatioY = 1.0;
        this.correctionFactorX = 1.0;
        this.correctionFactorY = 1.0;
      } else {
        this.calibrationRatioX = 1.0;
        this.calibrationRatioY = 1.0;
        this.correctionFactorX = 1.0;
        this.correctionFactorY = 1.0;
      }
    } catch (error) {
      this.calibrationRatioX = 1.0;
      this.calibrationRatioY = 1.0;
      this.correctionFactorX = 1.0;
      this.correctionFactorY = 1.0;
    }
  }

  private convertHTMLToSystemCoordinates(htmlX: number, htmlY: number): { x: number; y: number } {
    return {
      x: htmlX * 1.25,
      y: htmlY * 1.25,
    };
  }

  private analyzeCoordinateAccuracy(htmlPos: any, systemPos: any): void {
    if (!htmlPos || !systemPos) return;
    const deltaX = Math.abs(systemPos.x - htmlPos.x);
    const deltaY = Math.abs(systemPos.y - htmlPos.y);
    if (deltaX > 2 || deltaY > 2) {
    }
  }

  private async exportCursors(): Promise<void> {
    console.log('=== EXPORT DES CURSEURS AU DÉMARRAGE ===');

    try {
      let scriptPath: string;

      if (app.isPackaged) {
        scriptPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'export-cursors.ps1');
      } else {
        scriptPath = path.join(__dirname, '..', 'export-cursors.ps1');
      }

      console.log(`Chemin du script PowerShell: ${scriptPath}`);

      if (!fs.existsSync(scriptPath)) {
        console.error(`Script PowerShell introuvable: ${scriptPath}`);
        return;
      }

      const workingDir = path.dirname(scriptPath);
      console.log(`Répertoire de travail: ${workingDir}`);

      return new Promise<void>((resolve, reject) => {
        const command = `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`;

        exec(
          command,
          {
            cwd: workingDir,
            timeout: 30000,
          },
          (error, stdout, stderr) => {
            if (error) {
              console.error("Erreur lors de l'export des curseurs:", error.message);
              reject(error);
              return;
            }

            if (stderr) {
              console.warn('Avertissements PowerShell:', stderr);
            }

            if (stdout) {
              console.log('Sortie PowerShell:', stdout);
            }

            console.log('✅ Export des curseurs terminé avec succès');
            resolve();
          },
        );
      });
    } catch (error) {
      console.error("Erreur lors de l'export des curseurs:", error);
      throw error;
    }
  }

  private startPeriodicCursorExport(): void {
    this.periodicExportTimer = setInterval(() => {
      console.log('=== EXPORT PÉRIODIQUE DES CURSEURS ===');
      this.exportCursors().catch((error) => {
        console.warn("Erreur lors de l'export périodique des curseurs:", error);
      });
    }, 5 * 60 * 1000);

    console.log('Export périodique des curseurs démarré (toutes les 5 minutes)');
  }

  private convertSystemToHTMLCoordinates(systemX: number, systemY: number): { x: number; y: number } {
    return {
      x: systemX,
      y: systemY,
    };
  }

  private startMouseInput(): void {
    try {
      const success = this.mouseDetector.start();

      if (success) {
        this.centerSystemCursor();
      }
    } catch (error) {}

    try {
      this.cursorTypeDetector.start();
    } catch (error) {}
  }

  private createTray(): void {
    try {
      let iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');

      if (!fs.existsSync(iconPath)) {
        iconPath = path.join(process.resourcesPath, 'assets', 'icon.ico');
      }

      if (!fs.existsSync(iconPath)) {
        iconPath = path.join(process.resourcesPath, 'app', 'assets', 'icon.ico');
      }

      console.log('Tentative de chargement icône tray:', iconPath);
      console.log('Icône existe:', fs.existsSync(iconPath));

      let trayImage: Electron.NativeImage;
      if (fs.existsSync(iconPath)) {
        trayImage = nativeImage.createFromPath(iconPath);
        console.log('Icône tray chargée avec succès');
      } else {
        console.log('Icône tray non trouvée, utilisation icône vide');
        trayImage = nativeImage.createEmpty();
      }

      this.tray = new Tray(trayImage);
      this.tray.setToolTip('Orionix');
      this.updateTrayMenu();

      this.tray.on('click', () => {
        if (!this.allowTrayLeftClick) {
          console.log('Left-click on tray ignored (allowTrayLeftClick=false)');
          return;
        }

        const anyVisible = Array.from(this.overlayWindows.values()).some((window) => window && !window.isDestroyed() && window.isVisible());

        this.overlayWindows.forEach((window) => {
          if (window && !window.isDestroyed()) {
            if (anyVisible) {
              window.hide();
            } else {
              window.show();
            }
          }
        });
      });

      this.tray.on('double-click', () => {
        this.openSettingsWindow();
      });
    } catch (error) {
      console.error('Erreur lors de la création de la tray:', error);
    }
  }

  private updateTrayMenu(): void {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Paramètres',
        click: () => {
          this.openSettingsWindow();
        },
      },
      {
        type: 'separator',
      },
      {
        label: 'Quitter',
        click: () => {
          this.shutdown();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  private openSettingsWindow(): void {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.focus();
      return;
    }

    this.createSettingsWindow();
  }

  private createSettingsWindow(): void {
    console.log('Création de la fenêtre de settings...');

    this.settingsWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 1000,
      minHeight: 700,
      maxWidth: 1400,
      maxHeight: 1000,
      frame: true,
      transparent: false,
      resizable: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false,
        devTools: true,
      },
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      title: 'Orionix - Paramètres',
    });

    this.settingsWindow.loadFile(path.join(__dirname, '..', 'settingsInterface', 'settings.html'));

    this.settingsWindow.once('ready-to-show', () => {
      console.log('Fenêtre de settings prête, affichage...');

      this.settingsWindow!.setSize(1400, 1000);
      this.settingsWindow!.center();
      this.settingsWindow!.show();

      this.settingsWindow!.setMenu(null);

      this.settingsWindow!.webContents.send('settings-config', this.config);
    });

    this.settingsWindow.on('closed', () => {
      console.log('Fenêtre de settings fermée');
      this.settingsWindow = null;
    });

    this.settingsWindow.webContents.on('did-finish-load', () => {
      this.setupSettingsIPC();
    });
  }

  private setupSettingsIPC(): void {
    ipcMain.on('settings-changed', (event, newSettings) => {
      console.log('Configuration mise à jour:', newSettings);
      this.updateConfig(newSettings);
    });

    ipcMain.on('get-current-config', (event) => {
      event.reply('current-config', this.config);
    });

    ipcMain.on('close-settings-window', () => {
      if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
        this.settingsWindow.close();
      }
    });

    ipcMain.on('reset-all-settings', (event, defaultSettings) => {
      try {
        console.log('🔄 Réinitialisation de config.json aux valeurs par défaut...');

        fs.writeFileSync(this.configPath, JSON.stringify(defaultSettings, null, 2));

        this.config = { ...defaultSettings };

        this.applySettingsChanges(defaultSettings);

        console.log('✅ Config.json réinitialisé avec succès');
        event.reply('settings-reset-complete', defaultSettings);

        this.sendToAllOverlays('settings-updated', this.config);
      } catch (error) {
        console.error('❌ Erreur lors de la réinitialisation de config.json:', error);
        event.reply('settings-reset-error', error instanceof Error ? error.message : 'Erreur inconnue');
      }
    });

    ipcMain.on('open-external-powershell', (event, url) => {
      try {
        console.log(`🔗 Ouverture de ${url} via PowerShell...`);
        const { spawn } = require('child_process');

        const powershellProcess = spawn('powershell', ['-Command', `Start-Process "${url}"`], {
          shell: true,
          stdio: 'ignore',
          detached: true,
        });

        powershellProcess.unref();
        console.log(`✅ URL ouverte avec succès: ${url}`);
      } catch (error) {
        console.error('❌ Erreur ouverture URL via PowerShell:', error);

        const { shell } = require('electron');
        shell.openExternal(url);
      }
    });

    ipcMain.on('get-system-cursor-size', async (event) => {
      try {
        console.log('🖱️ Récupération de la taille du curseur système...');
        const { spawn } = require('child_process');

        const powershellCommand = `Get-ItemProperty "HKCU:\\Control Panel\\Cursors" | Select-Object -ExpandProperty CursorBaseSize`;

        const process = spawn('powershell', ['-Command', powershellCommand], {
          shell: true,
          stdio: 'pipe',
        });

        let output = '';
        process.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });

        process.on('close', () => {
          const size = parseInt(output.trim());
          const cursorSize = isNaN(size) ? 32 : size;

          console.log(`✅ Taille du curseur système détectée: ${cursorSize}`);
          event.reply('system-cursor-size', cursorSize);

          if (cursorSize !== 32) {
            const clampedSize = Math.max(12, Math.min(64, cursorSize));
            this.updateConfig({ cursorSize: clampedSize });
          }
        });

        process.on('error', (error: Error) => {
          console.error('❌ Erreur lors de la récupération de la taille du curseur:', error);
          event.reply('system-cursor-size', 32);
        });
      } catch (error) {
        console.error('❌ Erreur générale lors de la récupération de la taille du curseur:', error);
        event.reply('system-cursor-size', 32);
      }
    });
  }

  private updateConfig(newSettings: Partial<AppConfig>): void {
    this.config = { ...this.config, ...newSettings };

    this.saveConfig();

    this.applySettingsChanges(newSettings);

    this.sendToAllOverlays('settings-updated', this.config);
  }

  private applySettingsChanges(newSettings: Partial<AppConfig>): void {
    if (newSettings.cursorSpeed !== undefined) {
      this.config.sensitivity = newSettings.cursorSpeed;
    }

    if (newSettings.cursorOpacity !== undefined) {
      this.config.cursorOpacity = newSettings.cursorOpacity;
      this.sendToAllOverlays('update-cursor-opacity', newSettings.cursorOpacity);
    }

    if (newSettings.overlayDebug !== undefined) {
      this.config.overlayDebug = newSettings.overlayDebug;
      this.sendToAllOverlays('toggle-debug-mode', newSettings.overlayDebug);
    }

    if (newSettings.colorIdentification !== undefined) {
      this.config.colorIdentification = newSettings.colorIdentification;
      this.sendToAllOverlays('update-color-identification', newSettings.colorIdentification);
    }

    if (newSettings.acceleration !== undefined) {
      this.config.acceleration = newSettings.acceleration;
    }

    this.saveConfig();

    console.log('Paramètres appliqués:', newSettings);
  }

  private setupGlobalShortcuts(): void {
    globalShortcut.register('CommandOrControl+Shift+S', () => {
      console.log('Raccourci paramètres activé');
      this.openSettingsWindow();
    });

    globalShortcut.register('CommandOrControl+Shift+D', () => {
      console.log('Raccourci debug activé');
      this.config.overlayDebug = !this.config.overlayDebug;
      this.applySettingsChanges({ overlayDebug: this.config.overlayDebug });
    });
  }

  private centerSystemCursor(): void {
    if (this.mouseDetector.rawInputModule?.setSystemCursorPos) {
      this.mouseDetector.rawInputModule.setSystemCursorPos(this.centerX, this.centerY);
    }
  }

  private handleMouseMove(mouseData: MouseMoveData): void {
    const cursorId = mouseData.deviceId;
    const deviceName = mouseData.deviceName || 'Device Inconnu';
    const isRawInput = mouseData.isRawInput || false;
    const deviceHandle = mouseData.deviceHandle || 'unknown';
    const dx = mouseData.dx || 0;
    const dy = mouseData.dy || 0;

    if (dx === 0 && dy === 0) {
      return;
    }

    let cursor = this.cursors.get(cursorId);
    if (!cursor) {
      const colorIndex = this.getStableColorIndex(cursorId);
      cursor = {
        id: cursorId,
        deviceName: deviceName,
        deviceHandle: deviceHandle,
        x: this.centerX,
        y: this.centerY,
        color: this.config.cursorColors[colorIndex],
        lastUpdate: performance.now(),
        isRawInput: isRawInput,
        cursorType: 'arrow',
        cursorCSS: 'cursor-type-arrow',
        cursorFile: 'aero_arrow.cur',
        hasMovedOnce: false,
        totalMovement: 0,
      };
      this.cursors.set(cursorId, cursor);
      this.manageSystemCursorVisibility();
    }

    const newX = cursor.x + dx * this.config.sensitivity;
    const newY = cursor.y + dy * this.config.sensitivity;

    cursor.x = Math.max(0, Math.min(this.screenWidth, newX));
    cursor.y = Math.max(0, Math.min(this.screenHeight, newY));
    cursor.lastUpdate = performance.now();

    const movement = Math.abs(dx) + Math.abs(dy);
    cursor.totalMovement = (cursor.totalMovement || 0) + movement;

    if (cursor.totalMovement > 10) {
      cursor.hasMovedOnce = true;
    }

    if (cursorId === this.lastActiveDevice) {
      const currentType = this.cursorTypeDetector.getCurrentCursorType();
      if (cursor.cursorType !== currentType) {
        cursor.cursorType = currentType;
        cursor.cursorCSS = this.cursorTypeDetector.getCursorCSS();
        cursor.cursorFile = this.cursorTypeDetector.getCursorFile();
      }
    }

    this.lastActiveDevice = cursorId;

    if (this.config.highPerformanceMode && cursorId === this.lastActiveDevice) {
      this.syncSystemCursorToHTML(cursor);
    }

    this.sendInstantCursorUpdate(cursor);
  }

  sendInstantCursorUpdate(cursor: CursorState): void {
    if (cursor.hasMovedOnce) {
      this.sendToAllOverlays('cursor-position-update', {
        deviceId: cursor.id,
        x: cursor.x,
        y: cursor.y,
        cursorType: cursor.cursorType,
        cursorCSS: cursor.cursorCSS,
        cursorFile: cursor.cursorFile,
        timestamp: performance.now(),
        isActive: cursor.id === this.lastActiveDevice,
      });
    }
  }

  private getStableColorIndex(deviceId: string): number {
    let hash = 0;
    for (let i = 0; i < deviceId.length; i++) {
      const char = deviceId.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }

    return Math.abs(hash) % this.config.cursorColors.length;
  }

  private removeCursor(deviceId: string): void {
    if (this.cursors.has(deviceId)) {
      const cursor = this.cursors.get(deviceId)!;
      console.log(`=== REMOVING CURSOR ===`);
      console.log(`Suppression du curseur pour device: ${deviceId}`);
      console.log(`Device name: ${cursor.deviceName}`);
      console.log(`Last update: ${new Date(cursor.lastUpdate).toLocaleTimeString()}`);
      console.log(`Total movement: ${cursor.totalMovement.toFixed(2)}`);

      this.cursors.delete(deviceId);
      this.manageSystemCursorVisibility();

      console.log(`Envoi de l'événement cursor-removed au renderer...`);
      this.sendToAllOverlays('cursor-removed', deviceId);

      if (this.lastActiveDevice === deviceId) {
        const remainingCursors = Array.from(this.cursors.keys());
        this.lastActiveDevice = remainingCursors.length > 0 ? remainingCursors[0] : null;
        console.log(`Device actif changé vers: ${this.lastActiveDevice || 'aucun'}`);
      }

      this.updateDeviceDisplay();

      console.log(`Curseur ${deviceId} supprimé avec succès. Curseurs restants: ${this.cursors.size}`);
    } else {
      console.log(`⚠️ Tentative de suppression d'un curseur inexistant: ${deviceId}`);
    }
  }

  private updateDeviceDisplay(): void {
    this.overlayWindows.forEach((window) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('devices-updated', {
          count: this.mouseDetector.getDeviceCount(),
          devices: this.mouseDetector.getConnectedDevices(),
        });
      }
    });
  }

  private sendToAllOverlays(channel: string, data: any): void {
    this.overlayWindows.forEach((window) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send(channel, data);
      }
    });
  }

  private createOverlayWindows(): void {
    console.log('Creation des fenetres overlay pour tous les ecrans...');

    this.closeAllOverlays();

    const displays = screen.getAllDisplays();
    console.log(`Nombre d'ecrans detectes: ${displays.length}`);

    displays.forEach((display, index) => {
      console.log(`Creation overlay pour ecran ${index + 1}:`, {
        id: display.id,
        bounds: display.bounds,
        size: display.size,
      });

      const overlayWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        show: false,
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
          webSecurity: false,
          devTools: true,
        },
      });

      overlayWindow.setAlwaysOnTop(true, 'screen-saver', 10);
      overlayWindow.loadFile(path.join(__dirname, '..', 'overlay.html'));

      overlayWindow.once('ready-to-show', () => {
        console.log(`Fenetre overlay ${index + 1} prete, affichage...`);
        overlayWindow.show();
        overlayWindow.setIgnoreMouseEvents(true);

        overlayWindow.webContents.send('screen-info', {
          displayId: display.id,
          bounds: display.bounds,
          size: display.size,
          isPrimary: display.id === screen.getPrimaryDisplay().id,
        });

        if (index === 0) {
          setTimeout(() => {
            this.sendExistingCursorsToRenderer();
          }, 1000);
        }
      });

      overlayWindow.on('closed', () => {
        console.log(`Fenêtre overlay ${index + 1} fermée`);
        this.overlayWindows.delete(display.id);
      });

      overlayWindow.on('close', (e) => {
        if (index === 0) {
          console.log("Fermeture de l'application demandée");
          this.shutdown();
        }
      });

      this.overlayWindows.set(display.id, overlayWindow);
    });
  }

  private closeAllOverlays(): void {
    this.overlayWindows.forEach((window) => {
      if (window && !window.isDestroyed()) {
        window.close();
      }
    });
    this.overlayWindows.clear();
  }

  private sendExistingCursorsToRenderer(): void {
    console.log('=== ENVOI CURSEURS EXISTANTS A TOUS LES RENDERERS ===');
    const existingCursors = Array.from(this.cursors.values()).map((cursor) => ({
      deviceId: cursor.id,
      x: cursor.x,
      y: cursor.y,
      color: cursor.color,
      cursorType: cursor.cursorType,
      cursorCSS: cursor.cursorCSS,
      cursorFile: cursor.cursorFile,
      isVisible: true,
    }));

    console.log('Curseurs à envoyer:', existingCursors);

    if (existingCursors.length > 0) {
      this.sendToAllOverlays('cursors-instant-update', {
        cursors: existingCursors,
        lastActiveDevice: this.lastActiveDevice,
        timestamp: performance.now(),
      });
    }
  }

  private setupIPC(): void {
    ipcMain.handle('get-config', () => {
      return this.config;
    });

    ipcMain.handle('get-device-count', () => {
      return this.mouseDetector.getDeviceCount();
    });

    ipcMain.on('mouse-move', (_event, mouseData: MouseMoveData) => {
      this.handleMouseMove(mouseData);
    });

    ipcMain.on('renderer-ready', () => {
      console.log("=== RENDERER SIGNALE QU'IL EST PRET ===");
      this.sendExistingCursorsToRenderer();
    });

    ipcMain.handle('increase-sensitivity', () => {
      this.increaseSensitivity();
      return this.config.sensitivity;
    });

    ipcMain.handle('decrease-sensitivity', () => {
      this.decreaseSensitivity();
      return this.config.sensitivity;
    });

    ipcMain.handle('reset-sensitivity', () => {
      this.resetSensitivity();
      return this.config.sensitivity;
    });

    ipcMain.handle('force-scan-devices', () => {
      console.log('[IPC] Force scan des périphériques demandé');

      return { success: true, message: 'Surveillance USB automatique active' };
    });

    ipcMain.handle('get-monitored-devices', () => {
      const devices = this.mouseDetector.getMonitoredDevices();
      console.log('[IPC] Périphériques surveillés:', devices.length);
      return devices;
    });

    ipcMain.handle('get-active-cursors', () => {
      const cursors = Array.from(this.cursors.values());
      console.log('[IPC] Curseurs actifs:', cursors.length);
      return cursors.map((cursor) => ({
        id: cursor.id,
        deviceName: cursor.deviceName,
        x: cursor.x,
        y: cursor.y,
        lastUpdate: cursor.lastUpdate,
        hasMovedOnce: cursor.hasMovedOnce,
        totalMovement: cursor.totalMovement,
      }));
    });

    ipcMain.handle('clear-disconnected-cursors', () => {
      console.log('[IPC] Nettoyage des curseurs déconnectés demandé');
      const clearedCount = this.clearDisconnectedCursors();
      return { success: true, clearedCount, message: `${clearedCount} curseurs nettoyés` };
    });

    ipcMain.handle('simulate-device-disconnect', (_, deviceId: string) => {
      console.log(`[IPC] Simulation de déconnexion demandée pour: ${deviceId}`);
      this.simulateDeviceDisconnect(deviceId);
      return { success: true, message: `Déconnexion simulée pour ${deviceId}` };
    });

    ipcMain.handle('reset-config', () => {
      console.log('[IPC] Reset de configuration demandé');
      return this.resetConfig();
    });

    ipcMain.handle('reset-to-defaults', () => {
      console.log('[IPC] Reset aux valeurs par défaut demandé');
      return this.resetToDefaults();
    });

    ipcMain.handle('get-system-cursor-size', async () => {
      return await this.getSystemCursorSize();
    });

    ipcMain.on('get-system-cursor-size', async (event) => {
      const size = await this.getSystemCursorSize();
      event.reply('system-cursor-size', size);
    });
  }

  private increaseSensitivity(): void {
    this.config.sensitivity = Math.min(5.0, this.config.sensitivity + 0.1);
    this.sendConfigUpdate();
  }

  private decreaseSensitivity(): void {
    this.config.sensitivity = Math.max(0.1, this.config.sensitivity - 0.1);
    this.sendConfigUpdate();
  }

  private resetSensitivity(): void {
    this.config.sensitivity = DEFAULT_CONFIG.sensitivity;
    this.sendConfigUpdate();
  }

  private sendConfigUpdate(): void {
    this.sendToAllOverlays('config-updated', this.config);
  }

  private resetConfig(): { success: boolean; message: string } {
    try {
      this.config = { ...DEFAULT_CONFIG };

      this.saveConfig();

      this.sendToAllOverlays('config-updated', this.config);

      console.log('Configuration réinitialisée aux valeurs par défaut');
      return { success: true, message: 'Configuration réinitialisée avec succès' };
    } catch (error) {
      console.error('Erreur lors de la réinitialisation:', error);
      return { success: false, message: 'Erreur lors de la réinitialisation' };
    }
  }

  private resetToDefaults(): { success: boolean; message: string; config: AppConfig } {
    const result = this.resetConfig();
    return {
      ...result,
      config: this.config,
    };
  }

  private async getSystemCursorSize(): Promise<number> {
    try {
      if (process.platform === 'win32') {
        const { exec } = require('child_process');

        return new Promise<number>((resolve) => {
          exec('powershell -Command "try { $reg = Get-ItemProperty -Path \\"HKCU:\\\\Control Panel\\\\Cursors\\" -Name \\"CursorBaseSize\\" -ErrorAction SilentlyContinue; if ($reg) { $reg.CursorBaseSize } else { 32 } } catch { 32 }"', (error: any, stdout: any) => {
            if (error) {
              console.warn('Impossible de détecter la taille système, utilisation par défaut:', error);
              resolve(32);
            } else {
              const detectedSize = parseInt(stdout.toString().trim()) || 32;
              console.log('Taille de curseur système détectée:', detectedSize);
              resolve(Math.max(16, Math.min(128, detectedSize)));
            }
          });
        });
      }
      return 32;
    } catch (error) {
      console.error('Erreur lors de la détection de la taille système:', error);
      return 32;
    }
  }

  private loadConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        const loadedConfig = JSON.parse(configData);
        this.config = { ...DEFAULT_CONFIG, ...loadedConfig };
      } else {
        this.saveConfig();
      }
    } catch (error) {
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  private clearDisconnectedCursors(): number {
    const connectedDevices = this.mouseDetector.getConnectedDevices();
    const connectedDeviceIds = new Set(connectedDevices.map((d) => d.id));

    let clearedCount = 0;
    const cursorsToRemove: string[] = [];

    for (const [cursorId, cursor] of this.cursors) {
      if (!connectedDeviceIds.has(cursorId)) {
        console.log(`[ClearCursors] Curseur orphelin détecté: ${cursorId} - ${cursor.deviceName}`);
        cursorsToRemove.push(cursorId);
      }
    }

    for (const cursorId of cursorsToRemove) {
      this.removeCursor(cursorId);
      clearedCount++;
    }

    console.log(`[ClearCursors] ${clearedCount} curseurs orphelins supprimés`);
    return clearedCount;
  }

  private simulateDeviceDisconnect(deviceId: string): void {
    console.log(`[SimulateDisconnect] Simulation de déconnexion pour: ${deviceId}`);

    if (this.cursors.has(deviceId)) {
      console.log(`[SimulateDisconnect] Suppression du curseur: ${deviceId}`);
      this.removeCursor(deviceId);
    }

    if (this.mouseDetector && typeof this.mouseDetector.removeDevice === 'function') {
      this.mouseDetector.removeDevice(deviceId);
    }

    this.updateDeviceDisplay();
  }

  public shutdown(): void {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;

    console.log('Restauration du curseur système...');
    try {
      const addon = require(path.join(__dirname, '..', 'bin', 'win32-x64-116', 'Orionix.node'));
      if (this.cursorHidden) {
        const showResult = addon.showSystemCursor();
        console.log('Curseur système restauré:', showResult);

        if (!showResult) {
          console.log('Échec de la restauration automatique, tentative de restauration manuelle...');
        }
      } else {
        console.log("Le curseur système n'était pas masqué");
      }
    } catch (error) {
      console.error('Erreur lors de la restauration du curseur:', error);

      try {
        console.log('Tentative de restauration de secours...');
      } catch (fallbackError) {
        console.error('Échec de la restauration de secours:', fallbackError);
      }
    }

    if (this.renderRequestId) {
      clearImmediate(this.renderRequestId);
    }

    if (this.highPrecisionTimer) {
      clearTimeout(this.highPrecisionTimer);
    }

    if (this.periodicExportTimer) {
      clearInterval(this.periodicExportTimer);
      console.log("Timer d'export périodique arrêté");
    }

    if (this.fileWatcher) {
      this.fileWatcher.close();
    }

    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.close();
      this.settingsWindow = null;
    }

    this.closeAllOverlays();

    if (this.mouseDetector) {
      this.mouseDetector.stop();
    }

    if (this.cursorTypeDetector) {
      this.cursorTypeDetector.stop();
    }

    globalShortcut.unregisterAll();

    this.saveConfig();
    app.quit();
  }
}

const OrionixApp = new OrionixAppElectron();

console.log('Orionix Electron app started.');

process.on('uncaughtException', (_error: Error) => {
  console.log('Exception non capturée détectée, restauration des curseurs...');
  OrionixApp.shutdown();
});

process.on('unhandledRejection', (_reason: any) => {});

process.on('SIGINT', () => {
  console.log('Signal SIGINT reçu, restauration des curseurs...');
  OrionixApp.shutdown();
});

process.on('SIGTERM', () => {
  console.log('Signal SIGTERM reçu, restauration des curseurs...');
  OrionixApp.shutdown();
});

if (process.platform === 'win32') {
  process.on('SIGHUP', () => {
    console.log('Signal SIGHUP reçu, restauration des curseurs...');
    OrionixApp.shutdown();
  });
}

