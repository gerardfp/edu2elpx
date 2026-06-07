import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { marked } from 'marked';
import AdmZip from 'adm-zip';

// Global variables to hold the active compiler/server state
let server: http.Server | null = null;
let serverPort: number = 0;
let lastUpdateTimestamp: number = Date.now();
let activeDocumentPath: string = '';
let inMemoryPages: Record<string, string> = {};
let compiledPagesList: EdumarkPage[] = [];
let compiledMetadata: Record<string, string> = {};
let outputChannel: vscode.OutputChannel;
let extensionPath: string = '';
let collectedResources = new Set<string>();

let edumarkApi: any = null;

function getEdumarkApi(): any {
    if (edumarkApi) return edumarkApi;
    const ext = vscode.extensions.getExtension('gerardfp.edumark-vscode');
    if (ext) {
        if (!ext.isActive) {
            // activate is called automatically on exports access in newer vscode, but we can do it safely
            // since we return the exports.
        }
        edumarkApi = ext.exports;
        return edumarkApi;
    }
    throw new Error('La extensión Edumark no está instalada o activa.');
}

function getComponentPath(name: string, workspaceDir: string): string | null {
    const isSymbol = SYMBOL_NAMES.has(name);
    const compFileName = isSymbol ? `sym_${name}.js` : `${name}.js`;

    // 1. Search in ".config/components" of the project (primary)
    const projectDotConfigPath = path.join(workspaceDir, '.config', 'components', compFileName);
    if (fs.existsSync(projectDotConfigPath)) {
        return projectDotConfigPath;
    }

    // 2. Search in "config/components" of the project (alias)
    const projectConfigPath = path.join(workspaceDir, 'config', 'components', compFileName);
    if (fs.existsSync(projectConfigPath)) {
        return projectConfigPath;
    }

    // 3. Search in legacy "components" of the project as fallback
    const legacyPath = path.join(workspaceDir, 'components', compFileName);
    if (fs.existsSync(legacyPath)) {
        return legacyPath;
    }

    // 4. Search in "components" of the extension itself
    if (extensionPath) {
        const extCompPath = path.join(extensionPath, 'components', compFileName);
        if (fs.existsSync(extCompPath)) {
            return extCompPath;
        }
    }

    return null;
}

// Interfaces for Edumark structure
interface EdumarkPage {
    id: string;
    title: string;
    level: number;
    slug: string;
    filename: string;
    parent: EdumarkPage | null;
    children: EdumarkPage[];
    sections: EdumarkSection[];
    type?: string;
    options?: any;
}

interface EdumarkSection {
    blockId: string;
    componentId: string;
    title: string;
    contentLines: string[];
    contentHtml?: string;
}

interface SectionBlock {
    type: 'text' | 'directive' | 'component';
    name?: string;
    title?: string;
    level?: number;
    content?: string[];
    children?: SectionBlock[];
    literalStr?: string;
}

const SYMBOL_NAMES = new Set([
    'excl', 'quot', 'num', 'dollar', 'percnt', 'amp', 'apos', 'lparen', 'rparen',
    'ast', 'plus', 'comma', 'minus', 'period', 'sol', 'colon', 'semi', 'lt',
    'equals', 'gt', 'quest', 'commat', 'lsqb', 'bsol', 'rsqb', 'Hat', 'lowbar',
    'grave', 'lcub'
]);

// Utility to generate unique IDs in eXeLearning standard style
function generateId(): string {
    return Math.random().toString(36).substring(2, 9) + '_' + Math.random().toString(36).substring(2, 9);
}

// Generates a URL-safe, clean slug from a page title
function generateSlug(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove accents/diacritics
        .replace(/[^a-z0-9]+/g, '_')     // Replace non-alphanumeric with underscores
        .replace(/^_+|_+$/g, '');        // Trim leading/trailing underscores
}

// Escapes special characters for XML content
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Helper to parse a block of HTML and check if it is a root-level idevice node
function parseIdeviceHtml(html: string): { id: string; type: string; innerHtml: string; isIdevice: boolean } {
    const trimmed = html.trim();
    // Must start with <div and have class containing "idevice_node" in the first tag
    if (!trimmed.startsWith('<div')) {
        return { id: '', type: '', innerHtml: '', isIdevice: false };
    }
    
    // Find the end of the opening tag safely ignoring quotes
    let firstTagEnd = -1;
    let inQuotes = false;
    let quoteChar = '';
    for (let i = 0; i < trimmed.length; i++) {
        const char = trimmed[i];
        if ((char === '"' || char === "'") && (i === 0 || trimmed[i-1] !== '\\')) {
            if (!inQuotes) {
                inQuotes = true;
                quoteChar = char;
            } else if (char === quoteChar) {
                inQuotes = false;
            }
        }
        if (!inQuotes && char === '>') {
            firstTagEnd = i;
            break;
        }
    }
    
    if (firstTagEnd === -1) {
        return { id: '', type: '', innerHtml: '', isIdevice: false };
    }
    
    const openingTag = trimmed.substring(0, firstTagEnd + 1);
    if (!openingTag.includes('idevice_node')) {
        return { id: '', type: '', innerHtml: '', isIdevice: false };
    }
    
    // Verify it ends with </div>
    if (!trimmed.endsWith('</div>')) {
        return { id: '', type: '', innerHtml: '', isIdevice: false };
    }
    
    // Extract attributes from opening tag
    const idMatch = openingTag.match(/\bid=["']([^"']+)["']/i);
    const id = idMatch ? idMatch[1] : '';
    
    const typeMatch = openingTag.match(/\bdata-idevice-type=["']([^"']+)["']/i);
    let type = typeMatch ? typeMatch[1] : '';
    if (!type) {
        const classMatch = openingTag.match(/\bclass=["']([^"']+)["']/i);
        if (classMatch) {
            const classes = classMatch[1].split(/\s+/);
            type = classes.find(c => c !== 'idevice_node' && c !== 'loaded' && c !== 'text') || 'text';
        }
    }
    
    const innerHtml = trimmed.substring(firstTagEnd + 1, trimmed.length - 6);
    return { id, type, innerHtml, isIdevice: true };
}

// Helper to generate the elpx-manifest.js content dynamically
function generateElpxManifest(pages: EdumarkPage[], metadata: Record<string, string>, collectedResources: Set<string>): string {
    const packageTitle = metadata.titulo || 'Proyecto Edumark';
    
    // Core files always present in the build
    const coreFiles = [
        "content/css/base.css",
        "theme/config.xml",
        "theme/style.css",
        "theme/style.js",
        "libs/jquery/jquery.min.js",
        "libs/bootstrap/bootstrap.bundle.min.js",
        "libs/bootstrap/bootstrap.min.css",
        "libs/common.js",
        "libs/common_i18n.js",
        "libs/exe_export.js",
        "libs/favicon.ico",
        "libs/exe_effects/exe_effects.js",
        "libs/exe_effects/exe_effects.css",
        "libs/fflate/fflate.umd.js",
        "libs/exe_elpx_download/exe_elpx_download.js",
        "idevices/text/text.css",
        "idevices/text/text.js",
        "idevices/rubric/rubric.css",
        "idevices/rubric/rubric.js",
        "idevices/rubric/exequextsq.svg",
        "idevices/rubric/html2canvas.js",
        "idevices/download-source-file/download-package-licenses.png",
        "idevices/download-source-file/download-source-file.css",
        "idevices/download-source-file/download-source-file.js",
        "idevices/download-source-file/exequextsq.svg",
        "libs/elpx-manifest.js"
    ];

    // Add all HTML pages
    const pageFiles = pages.map(p => p.filename);

    // Add collected resource files
    const resourceFiles = Array.from(collectedResources);

    const allFiles = [...coreFiles, ...pageFiles, ...resourceFiles];

    const manifestObj = {
        version: 1,
        files: allFiles,
        projectTitle: packageTitle
    };

    return `/**
 * ELPX Manifest - Auto-generated for download-source-file iDevice
 * Used by exe_elpx_download.js to recreate the complete export package
 */
window.__ELPX_MANIFEST__ = ${JSON.stringify(manifestObj, null, 2)};
`;
}

// Process custom image attributes (like {ancho:600}) in markdown text
function processCustomImages(text: string): string {
    return text.replace(/!\[(.*?)\]\((.*?)\)\s*\{([^}]+)\}/g, (match, alt, src, attrsStr) => {
        const attrs: Record<string, string> = {};
        const pairs = attrsStr.split(',');
        for (const pair of pairs) {
            const eqIdx = pair.indexOf(':');
            if (eqIdx !== -1) {
                const k = pair.substring(0, eqIdx).trim().toLowerCase();
                const v = pair.substring(eqIdx + 1).trim();
                attrs[k] = v;
            }
        }
        let html = `<img src="${src}" alt="${alt}"`;
        if (attrs.ancho) {
            html += ` width="${attrs.ancho}"`;
        }
        if (attrs.alto) {
            html += ` height="${attrs.alto}"`;
        }
        html += ' />';
        return html;
    });
}

// Helper to compile markdown to HTML using marked
function compileMarkdown(text: string): string {
    text = processCustomImages(text);
    text = processGeometricTables(text);
    const renderer = new marked.Renderer();
    renderer.table = (header: string, body: string) => {
        return `<table class="exe-table">\n<thead>\n${header}</thead>\n<tbody>\n${body}</tbody>\n</table>\n`;
    };
    return marked.parse(text, { renderer }) as string;
}

function parseSectionContent(lines: string[], metadata?: Record<string, string>): SectionBlock[] {
    const api = getEdumarkApi();
    return api.parseSectionContent(lines, metadata);
}

function parseParametersString(str: string): Record<string, any> {
    const api = getEdumarkApi();
    return api.parseParametersString(str);
}

// Compiles a tabs block (@pestanas, @acordeon, etc.) into eXeLearning FX structures
function compileTabsBlock(
    name: string, 
    children: SectionBlock[],
    workspaceDir: string,
    currentPage: EdumarkPage,
    currentSection: EdumarkSection,
    pages: EdumarkPage[],
    metadata: Record<string, string>
): string {
    const fxClass = name === 'pestanas' ? 'exe-tabs' :
                    name === 'acordeon' ? 'exe-accordion' :
                    name === 'carrusel' ? 'exe-carousel' :
                    name === 'paginacion' ? 'exe-paginated' : 'exe-accordion';

    interface Tab {
        title: string;
        html: string;
        pendingLines: string[];
    }

    const tabs: Tab[] = [];
    let currentTab: Tab | null = null;

    function flushPendingLines() {
        if (currentTab && currentTab.pendingLines.length > 0) {
            currentTab.html += compileMarkdown(currentTab.pendingLines.join('\n'));
            currentTab.pendingLines = [];
        }
    }

    for (const child of children) {
        if (child.type === 'directive' && child.name === 'item') {
            flushPendingLines();
            currentTab = {
                title: child.title || '',
                html: '',
                pendingLines: []
            };
            tabs.push(currentTab);
            if (child.children && child.children.length > 0) {
                currentTab.html += child.children.map(subChild =>
                    compileBlock(subChild, workspaceDir, currentPage, currentSection, pages, metadata)
                ).join('\n') + '\n';
            }
        } else if (child.type === 'text') {
            for (const line of child.content!) {
                if (line.trim() === '' && !currentTab) {
                    continue;
                }
                const match = line.trim().match(/^%\s+(.+)$/);
                if (match) {
                    flushPendingLines();
                    currentTab = {
                        title: match[1].trim(),
                        html: '',
                        pendingLines: []
                    };
                    tabs.push(currentTab);
                } else {
                    if (!currentTab) {
                        currentTab = {
                            title: 'Introducción',
                            html: '',
                            pendingLines: []
                        };
                        tabs.push(currentTab);
                    }
                    currentTab.pendingLines.push(line);
                }
            }
        } else {
            if (!currentTab) {
                currentTab = {
                    title: 'Introducción',
                    html: '',
                    pendingLines: []
                };
                tabs.push(currentTab);
            }
            flushPendingLines();
            currentTab.html += compileBlock(child, workspaceDir, currentPage, currentSection, pages, metadata) + '\n';
        }
    }
    flushPendingLines();

    let html = `<div class="exe-fx ${fxClass}">\n`;
    for (const tab of tabs) {
        html += `<h2>${escapeHtml(tab.title)}</h2>\n`;
        html += `<div>\n${tab.html}</div>\n`;
    }
    html += `</div>\n`;
    return html;
}

// Compiles a section block into HTML, wrapping didactical blocks nicely or executing dynamic components
function compileBlock(
    block: SectionBlock,
    workspaceDir: string,
    currentPage: EdumarkPage,
    currentSection: EdumarkSection,
    pages: EdumarkPage[],
    metadata: Record<string, string>
): string {
    if (block.type === 'text') {
        return compileMarkdown(block.content!.join('\n'));
    }

    if (block.name && block.name.toLowerCase() === 'ataula') {
        const innerHtml = (block.children || []).map(child => compileBlock(child, workspaceDir, currentPage, currentSection, pages, metadata)).join('\n');
        const title = block.title || '';
        if (title) {
            const captionHtml = `<caption>${escapeHtml(title)}</caption>`;
            if (innerHtml.includes('<table class="exe-table">')) {
                return innerHtml.replace('<table class="exe-table">', `<table class="exe-table">${captionHtml}`);
            } else if (innerHtml.includes('<table>')) {
                return innerHtml.replace('<table>', `<table>${captionHtml}`);
            }
        }
        return innerHtml;
    }

    if (block.type === 'component') {
        const name = block.name || '';
        const literalStr = block.literalStr || '{}';
        
        try {
            // 1. Parse the JS object options literal
            const options = parseParametersString(literalStr);
            
            // If the block has a level, add it to options
            if (block.level !== undefined && options.level === undefined) {
                options.level = block.level;
            }
            
            // 2. Resolve component script path using getComponentPath
            const compPath = getComponentPath(name, workspaceDir);
            
            if (!compPath) {
                // Render default simple div fallback
                let contentHtml = '';
                if (options.title || options.titulo) {
                    contentHtml += `<h3>${escapeHtml(options.title || options.titulo)}</h3>\n`;
                }
                if (options.content || options.contenido) {
                    contentHtml += `<div>${compileMarkdown(options.content || options.contenido)}</div>\n`;
                } else {
                    const items = Object.entries(options)
                        .filter(([k]) => k !== 'title' && k !== 'titulo')
                        .map(([k, v]) => `<strong>${escapeHtml(k)}:</strong> ${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}`)
                        .join('<br/>\n');
                    if (items) {
                        contentHtml += `<div>${items}</div>\n`;
                    }
                }
                return `<div class="component-${escapeHtml(name)}">\n${contentHtml}\n</div>`;
            }
            
            // 3. Clear cache and dynamically require the component module
            let compModule;
            try {
                const resolvedPath = require.resolve(compPath);
                delete require.cache[resolvedPath];
                compModule = require(compPath);
            } catch (err: any) {
                return `
                <div class="edumark-block-error" style="border: 2px dashed #ef4444; padding: 15px; border-radius: 8px; background-color: #fef2f2; color: #b91c1c; margin: 10px 0; font-family: sans-serif;">
                    <div style="font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; gap: 8px;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                        <span>Error al cargar componente: "${escapeHtml(name)}"</span>
                    </div>
                    <pre style="font-size: 12px; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 5px 0 0 0;">${escapeHtml(err.stack || err.message)}</pre>
                </div>
                `;
            }
            
            // 4. Validate that the exported module is a function
            const renderFn = typeof compModule === 'function' ? compModule : compModule.default;
            if (typeof renderFn !== 'function') {
                return `
                <div class="edumark-block-error" style="border: 2px dashed #f59e0b; padding: 15px; border-radius: 8px; background-color: #fffbeb; color: #b45309; margin: 10px 0; font-family: sans-serif;">
                    <div style="font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; gap: 8px;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                        <span>Componente no exporta una función: "${escapeHtml(name)}"</span>
                    </div>
                    <div style="font-size: 13px;">Asegúrate de que <code>module.exports = function(...) { ... }</code> o <code>export default function(...) { ... }</code> esté definido.</div>
                </div>
                `;
            }
            
            // 5. Execute the component function with context and options
            const context = {
                metadata,
                pages,
                workspaceDir,
                currentPage,
                currentSection,
                compileBlock: (b: any) => compileBlock(b, workspaceDir, currentPage, currentSection, pages, metadata),
                compileMarkdown: (t: string) => compileMarkdown(t)
            };
            
            const resultHtml = renderFn(options, context);
            if (typeof resultHtml !== 'string') {
                return `
                <div class="edumark-block-error" style="border: 2px dashed #f59e0b; padding: 15px; border-radius: 8px; background-color: #fffbeb; color: #b45309; margin: 10px 0; font-family: sans-serif;">
                    <div style="font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; gap: 8px;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
                        <span>Retorno inválido en: "${escapeHtml(name)}"</span>
                    </div>
                    <div style="font-size: 13px;">El componente no retornó una cadena de texto (HTML). Retornó tipo: <code>${typeof resultHtml}</code>.</div>
                </div>
                `;
            }
            
            return resultHtml;
            
        } catch (err: any) {
            return `
            <div class="edumark-block-error" style="border: 2px dashed #ef4444; padding: 15px; border-radius: 8px; background-color: #fef2f2; color: #b91c1c; margin: 10px 0; font-family: sans-serif;">
                <div style="font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; gap: 8px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                    <span>Error de ejecución en componente: "${escapeHtml(name)}"</span>
                </div>
                <pre style="font-size: 12px; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 5px 0 0 0;">${escapeHtml(err.stack || err.message)}</pre>
            </div>
            `;
        }
    }

    const name = block.name!.toLowerCase();
    const title = block.title || '';

    const innerHtml = (block.children || []).map(child => compileBlock(child, workspaceDir, currentPage, currentSection, pages, metadata)).join('\n');

    if (name === 'ataula') {
        return innerHtml;
    }

    // 1. Check if a dynamic JS component exists with this directive name using getComponentPath
    const compPath = getComponentPath(name, workspaceDir);
    if (compPath) {
        try {
            const resolvedPath = require.resolve(compPath);
            delete require.cache[resolvedPath];
            const compModule = require(compPath);
            const renderFn = typeof compModule === 'function' ? compModule : compModule.default;
            if (typeof renderFn === 'function') {
                let options: any = {
                    title: title,
                    titulo: title,
                    level: block.level,
                    content: innerHtml,
                    children: block.children || []
                };
                if (block.literalStr) {
                    try {
                        const parsedOpts = parseParametersString(block.literalStr);
                        options = { ...options, ...parsedOpts };
                    } catch (e) {
                        console.error('Error parsing block options:', e);
                    }
                }
                const context = {
                    metadata,
                    pages,
                    workspaceDir,
                    currentPage,
                    currentSection,
                    compileBlock: (b: any) => compileBlock(b, workspaceDir, currentPage, currentSection, pages, metadata),
                    compileMarkdown: (t: string) => compileMarkdown(t)
                };
                const resultHtml = renderFn(options, context);
                if (typeof resultHtml === 'string') {
                    return resultHtml;
                }
            }
        } catch (err: any) {
            return `
            <div class="edumark-block-error" style="border: 2px dashed #ef4444; padding: 15px; border-radius: 8px; background-color: #fef2f2; color: #b91c1c; margin: 10px 0; font-family: sans-serif;">
                <div style="font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; gap: 8px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                    <span>Error al cargar componente directiva: "${escapeHtml(name)}"</span>
                </div>
                <pre style="font-size: 12px; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 5px 0 0 0;">${escapeHtml(err.stack || err.message)}</pre>
            </div>
            `;
        }
    }

    // 2. Built-in tabs/accordion compilation support
    if (['pestanas', 'acordeon', 'carrusel', 'paginacion'].includes(name)) {
        return compileTabsBlock(name, block.children || [], workspaceDir, currentPage, currentSection, pages, metadata);
    }

    // 2. Generic directive rendering fallback
    if (name === 'num') {
        const hTag = `h${block.level || 1}`;
        return `<${hTag}>${escapeHtml(title)}</${hTag}>\n${innerHtml}`;
    }

    if (['h1', 'h2', 'h3', 'h4', 'h5'].includes(name)) {
        return `<${name}>${escapeHtml(title)}</${name}>\n${innerHtml}`;
    }

    let titleHtml = '';
    if (title) {
        titleHtml = `<div class="block-title">${escapeHtml(title)}</div>`;
    } else {
        const defaultTitles: Record<string, string> = {
            ask_yourself: 'Pregúntate',
            preguntate: 'Pregúntate',
            warning: 'Atención',
            atencion: 'Atención',
            didyouknow: '¿Sabías que...?',
            sabiasque: '¿Sabías que...?',
            hint: 'Sugerencia',
            sugerencia: 'Sugerencia',
            solution: 'Solución',
            solucion: 'Solución',
            reflection: 'Reflexión',
            reflexion: 'Reflexión',
            activity: 'Actividad',
            actividad: 'Actividad',
            note: 'Nota',
            nota: 'Nota',
            question: 'Pregunta',
            pregunta: 'Pregunta',
            rubric: 'Rúbrica',
            rubrica: 'Rúbrica',
            generic: 'Información',
            informacion: 'Información'
        };
        const defaultTitle = defaultTitles[name] || (name.charAt(0).toUpperCase() + name.slice(1));
        titleHtml = `<div class="block-title">${escapeHtml(defaultTitle)}</div>`;
    }

    const classMap: Record<string, string> = {
        preguntate: 'ask_yourself',
        atencion: 'warning',
        sabiasque: 'didyouknow',
        sugerencia: 'hint',
        solucion: 'solution',
        reflexion: 'reflection',
        actividad: 'activity',
        nota: 'note',
        pregunta: 'question',
        rubrica: 'rubric',
        informacion: 'generic'
    };
    const styleClass = classMap[name] || name;

    return `<div class="edumark-block ${styleClass}${styleClass !== name ? ' ' + name : ''}">\n${titleHtml}\n<div class="block-content">\n${innerHtml}\n</div>\n</div>\n`;
}

// Parses an Edumark (.edu) file into structural pages and sections
function parseEdumark(source: string, aliasesModule?: any): { metadata: Record<string, string>; pages: EdumarkPage[] } {
    const api = getEdumarkApi();
    return api.parseEdumark(source, aliasesModule);
}

// Adjusts relative paths in compiled HTML depending on whether the page is in root or html/ subdirectory
function adjustRelativePaths(html: string, isSubpage: boolean): string {
    if (!isSubpage) {
        return html.replace(/\{REL_PREFIX\}/g, '');
    }
    let res = html.replace(/\{REL_PREFIX\}/g, '../');
    res = res.replace(/(href|src)=["']([^"']+)["']/gi, (match, attr, val) => {
        if (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('data:') || val.startsWith('/') || val.startsWith('#') || val.startsWith('javascript:')) {
            return match;
        }
        if (val.startsWith('../') || val.startsWith('content/resources/')) {
            return match;
        }
        // Skip modifying page links themselves!
        if (val.endsWith('.html') || val.endsWith('.htm')) {
            return match;
        }
        return `${attr}="../${val}"`;
    });
    return res;
}

// Scans for local assets in HTML, re-routes them to content/resources, and optionally copies them to the zip archive
function processResourcesInContent(
    content: string, 
    componentId: string, 
    zipWriter: any, 
    workspaceDir: string, 
    relPrefix: string,
    isXml: boolean = false
): string {
    // 1. Process <img> tags
    let processed = content.replace(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, before, src, after) => {
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:') || src.startsWith('/')) {
            return match;
        }
        if (src.includes('theme/')) {
            return match;
        }

        const filename = path.basename(decodeURIComponent(src));
        const fileFullPath = path.join(workspaceDir, filename);

        if (fs.existsSync(fileFullPath)) {
            collectedResources.add(`content/resources/${componentId}/${filename}`);
            if (zipWriter) {
                try {
                    const fileBuffer = fs.readFileSync(fileFullPath);
                    zipWriter.addFile(`content/resources/${componentId}/${filename}`, fileBuffer);
                } catch (err) {
                    console.error('Error bundling image:', err);
                }
            }
        }

        const newSrc = isXml 
            ? `{{context_path}}/${componentId}/${filename}`
            : `${relPrefix}content/resources/${componentId}/${filename}`;
            
        return `<img ${before}src="${newSrc}"${after}>`;
    });

    // 2. Process <a> tags for download links
    processed = processed.replace(/<a\s+([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi, (match, before, href, after) => {
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('data:') || href.startsWith('/') || href.startsWith('#') || href.startsWith('javascript:')) {
            return match;
        }
        if (href.includes('theme/')) {
            return match;
        }

        const filename = path.basename(decodeURIComponent(href));
        const fileFullPath = path.join(workspaceDir, filename);

        if (fs.existsSync(fileFullPath)) {
            collectedResources.add(`content/resources/${componentId}/${filename}`);
            if (zipWriter) {
                try {
                    const fileBuffer = fs.readFileSync(fileFullPath);
                    zipWriter.addFile(`content/resources/${componentId}/${filename}`, fileBuffer);
                } catch (err) {
                    console.error('Error bundling file:', err);
                }
            }
            const newHref = isXml
                ? `{{context_path}}/${componentId}/${filename}`
                : `${relPrefix}content/resources/${componentId}/${filename}`;
            return `<a ${before}href="${newHref}"${after}>`;
        }
        return match;
    });

    return processed;
}

// Determines the eXeLearning icon name based on section title
function getIconForSection(title: string): string {
    const t = title.toLowerCase();
    if (t.includes('reto') || t.includes('objetivos') || t.includes('mision') || t.includes('misión')) {
        return 'objectives.png';
    }
    if (t.includes('lectura') || t.includes('texto') || t.includes('leer')) {
        return 'reading.png';
    }
    return 'draw.png';
}

// Generates dynamic navigation HTML tree structure
function getRelativeLink(fromPage: EdumarkPage, toPage: EdumarkPage): string {
    const isFromSub = fromPage.filename !== 'index.html';
    const isToSub = toPage.filename !== 'index.html';

    if (isToSub) {
        // Link to a subpage (which is always in the html/ folder)
        return isFromSub ? `../${toPage.filename}` : toPage.filename;
    } else {
        // Link to the home page (index.html)
        return isFromSub ? '../index.html' : 'index.html';
    }
}

function generateSiteNav(allPages: EdumarkPage[], currentPage: EdumarkPage): string {
    const roots = allPages.filter(p => p.parent === null);

    function buildList(nodes: EdumarkPage[]): string {
        if (nodes.length === 0) return '';
        let html = '<ul>\n';
        for (const node of nodes) {
            const link = getRelativeLink(currentPage, node);
            const activeClass = node.id === currentPage.id ? 'active' : '';
            const mainNodeClass = node.filename === 'index.html' ? 'main-node' : '';
            const classes = [activeClass, mainNodeClass, 'no-ch'].filter(Boolean).join(' ');
            
            html += `<li class="${activeClass ? 'active' : ''}">`;
            html += `<a href="${link}" class="${classes}"><span>${escapeHtml(node.title)}</span></a>`;
            if (node.children && node.children.length > 0) {
                html += buildList(node.children);
            }
            html += `</li>\n`;
        }
        html += '</ul>\n';
        return html;
    }

    return `<nav id="siteNav">\n${buildList(roots)}</nav>`;
}

// Compiles Edumark structure into in-memory HTML pages based on template/index.html
function compileToHtmlPages(pages: EdumarkPage[], metadata: Record<string, string>, templateHtml: string, workspaceDir: string, injectHotReload: boolean): Record<string, string> {
    collectedResources.clear();
    const outputs: Record<string, string> = {};
    const packageTitle = metadata.titulo || 'Proyecto Edumark';

    // Compile section contents to HTML first
    for (const page of pages) {
        for (const sec of page.sections) {
            const parsedBlocks = parseSectionContent(sec.contentLines, metadata);
            sec.contentHtml = parsedBlocks.map(block => compileBlock(block, workspaceDir, page, sec, pages, metadata)).join('\n');
        }
    }

    const reloadScript = `
    <script>
        window.lastUpdate = window.lastUpdate || ${lastUpdateTimestamp};
        setInterval(async () => {
            try {
                const res = await fetch('/status');
                const data = await res.json();
                if (data.last_update > window.lastUpdate) {
                    window.location.reload();
                }
            } catch (e) {}
        }, 500);
    </script>
    `;

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const isSubpage = page.filename !== 'index.html';
        const relPrefix = isSubpage ? '../' : '';

        let pageHtml = templateHtml;

        // Replace titles
        pageHtml = pageHtml.replace(/<title>.*?<\/title>/gi, `<title>${escapeHtml(page.title)} | ${escapeHtml(packageTitle)}</title>`);
        pageHtml = pageHtml.replace(/<h1 class="package-title">.*?<\/h1>/gi, `<h1 class="package-title">${escapeHtml(packageTitle)}</h1>`);
        pageHtml = pageHtml.replace(/<h2 class="page-title">.*?<\/h2>/gi, `<h2 class="page-title">${escapeHtml(page.title)}</h2>`);

        // Replace site nav
        const siteNavHtml = generateSiteNav(pages, page);
        pageHtml = pageHtml.replace(/<nav id="siteNav">[\s\S]*?<\/nav>/gi, siteNavHtml);

        // Build content HTML
        let contentHtml = '';
        for (const sec of page.sections) {
            const hasHeader = sec.title !== '';
            const boxClass = hasHeader ? 'box' : 'box no-header';
            const icon = getIconForSection(sec.title);
            
            // Rewrite local image & link paths for current preview context
            const processedContentHtml = processResourcesInContent(sec.contentHtml || '', sec.componentId, null, workspaceDir, relPrefix);

            let secHtml = `<article class="${boxClass}" id="${sec.blockId}">\n`;
            if (hasHeader) {
                secHtml += `  <header class="box-head">\n`;
                secHtml += `    <div class="box-icon exe-icon">\n`;
                secHtml += `      <img src="{REL_PREFIX}theme/icons/${icon}" alt="" />\n`;
                secHtml += `    </div>\n`;
                secHtml += `    <h1 class="box-title">${escapeHtml(sec.title)}</h1>\n`;
                secHtml += `    <button class="box-toggle box-toggle-on" title="Ocultar/Mostrar contenido">\n`;
                secHtml += `      <span>Ocultar/Mostrar contenido</span>\n`;
                secHtml += `    </button>\n`;
                secHtml += `  </header>\n`;
            }
            secHtml += `  <div class="box-content">\n`;
            const parsedIdevice = parseIdeviceHtml(processedContentHtml);
            if (parsedIdevice.isIdevice) {
                secHtml += `    ${processedContentHtml}\n`;
            } else {
                secHtml += `    <div id="${sec.componentId}" class="idevice_node text loaded" data-idevice-path="idevices/text/" data-idevice-type="text" data-idevice-component-type="json">\n`;
                secHtml += `      <div class="exe-text-template">\n`;
                secHtml += `        <div class="textIdeviceContent">\n`;
                secHtml += `          <div class="exe-text-activity">\n`;
                secHtml += `            <div>${processedContentHtml}</div>\n`;
                secHtml += `          </div>\n`;
                secHtml += `        </div>\n`;
                secHtml += `      </div>\n`;
                secHtml += `    </div>\n`;
            }
            secHtml += `  </div>\n`;
            secHtml += `</article>\n`;

            contentHtml += secHtml;
        }

        // Check if a JS component exists with this page's hierarchical type
        const pageTypeName = page.type || 'pagina';
        const pageCompPath = path.join(workspaceDir, 'components', `${pageTypeName}.js`);
        let finalPageContentHtml = contentHtml;

        if (fs.existsSync(pageCompPath)) {
            try {
                const resolvedPath = require.resolve(pageCompPath);
                delete require.cache[resolvedPath];
                const compModule = require(pageCompPath);
                const renderFn = typeof compModule === 'function' ? compModule : compModule.default;
                if (typeof renderFn === 'function') {
                    const options = {
                        title: page.title,
                        titulo: page.title,
                        content: contentHtml,
                        children: [],
                        ...page.options
                    };
                    const context = {
                        metadata,
                        pages,
                        workspaceDir,
                        currentPage: page,
                        currentSection: null
                    };
                    const resultHtml = renderFn(options, context);
                    if (typeof resultHtml === 'string') {
                        finalPageContentHtml = resultHtml;
                    }
                }
            } catch (err: any) {
                finalPageContentHtml = `
                <div class="edumark-block-error" style="border: 2px dashed #ef4444; padding: 15px; border-radius: 8px; background-color: #fef2f2; color: #b91c1c; margin: 10px 0; font-family: sans-serif;">
                    <div style="font-weight: bold; margin-bottom: 5px; display: flex; align-items: center; gap: 8px;">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                        <span>Error al cargar componente página: "${escapeHtml(pageTypeName)}"</span>
                    </div>
                    <pre style="font-size: 12px; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 4px; overflow-x: auto; margin: 5px 0 0 0;">${escapeHtml(err.stack || err.message)}</pre>
                </div>
                ${contentHtml}
                `;
            }
        }

        pageHtml = pageHtml.replace(/<div class="page-content">[\s\S]*?<\/div>/gi, `<div class="page-content">\n${finalPageContentHtml}\n</div>`);

        // Setup nav buttons
        let buttonsHtml = '';
        if (i > 0) {
            const prevPage = pages[i - 1];
            buttonsHtml += `<a href="${getRelativeLink(page, prevPage)}" class="nav-button nav-button-left"><span>Anterior</span></a>\n`;
        } else {
            buttonsHtml += `<span class="nav-button nav-button-left" aria-hidden="true"><span>Anterior</span></span>\n`;
        }

        if (i < pages.length - 1) {
            const nextPage = pages[i + 1];
            buttonsHtml += `<a href="${getRelativeLink(page, nextPage)}" class="nav-button nav-button-right"><span>Següent</span></a>\n`;
        } else {
            buttonsHtml += `<span class="nav-button nav-button-right" aria-hidden="true"><span>Següent</span></span>\n`;
        }
        pageHtml = pageHtml.replace(/<div class="nav-buttons">[\s\S]*?<\/div>/gi, `<div class="nav-buttons">\n${buttonsHtml}</div>`);

        // Inject download source file scripts if this page has download-source-file idevice
        if (pageHtml.includes('download-source-file')) {
            const headScripts = `
<script src="{REL_PREFIX}idevices/download-source-file/download-source-file.js"></script>
<link rel="stylesheet" href="{REL_PREFIX}idevices/download-source-file/download-source-file.css">
<script src="{REL_PREFIX}libs/fflate/fflate.umd.js"></script>
<script src="{REL_PREFIX}libs/exe_elpx_download/exe_elpx_download.js"></script>
`;
            const bodyScripts = `
<script src="{REL_PREFIX}libs/elpx-manifest.js"></script>
`;
            if (pageHtml.includes('</head>')) {
                pageHtml = pageHtml.replace('</head>', `${headScripts}\n</head>`);
            }
            if (pageHtml.includes('</body>')) {
                pageHtml = pageHtml.replace('</body>', `${bodyScripts}\n</body>`);
            }
        }

        // Inject rubric scripts if this page has rubric idevice
        if (pageHtml.includes('data-idevice-type="rubric"') || pageHtml.includes('class="idevice_node rubric"')) {
            const rubricScripts = `
<script src="{REL_PREFIX}idevices/rubric/rubric.js"></script>
<link rel="stylesheet" href="{REL_PREFIX}idevices/rubric/rubric.css">
`;
            if (pageHtml.includes('</head>')) {
                pageHtml = pageHtml.replace('</head>', `${rubricScripts}\n</head>`);
            }
        }

        // Adjust stylesheet and javascript paths relative to subpages
        pageHtml = adjustRelativePaths(pageHtml, isSubpage);

        // Inject hot-reload script if preview mode
        if (injectHotReload && pageHtml.includes('</body>')) {
            pageHtml = pageHtml.replace('</body>', `${reloadScript}\n</body>`);
        }

        outputs[page.filename] = pageHtml;
    }

    // Generate manifest and save to in-memory pages
    const manifestContent = generateElpxManifest(pages, metadata, collectedResources);
    outputs['libs/elpx-manifest.js'] = manifestContent;

    return outputs;
}

// Extracts theme name from config.xml inside the workspace custom theme folder
function extractThemeName(themePath: string): string {
    const configPath = path.join(themePath, 'config.xml');
    if (!fs.existsSync(configPath)) {
        return path.basename(themePath);
    }
    try {
        const xml = fs.readFileSync(configPath, 'utf-8');
        const match = xml.match(/<name>([^<]+)<\/name>/i);
        if (match) {
            return match[1].trim();
        }
    } catch (err) {
        // Fallback
    }
    return path.basename(themePath);
}

// Generates the content.xml manifest for the eXeLearning zip archive
function generateContentXml(pages: EdumarkPage[], metadata: Record<string, string>, workspaceDir: string, themeName: string = 'base'): string {
    const packageTitle = metadata.titulo || 'Proyecto Edumark';
    const subtitle = metadata.subtitulo || '';
    const lang = metadata.idioma || 'es';
    const author = metadata.autoria || 'Autor';
    const license = metadata.licencia || 'public domain';
    const description = metadata.descripcion || '';

    let xml = `<?xml version="1.0" encoding="utf-8"?>
<ode xmlns="http://www.intef.es/xsd/ode" version="2.0">
    <userPreferences>
        <userPreference><key>theme</key><value>${escapeHtml(themeName)}</value></userPreference>
    </userPreferences>
    <odeResources>
        <odeResource><key>odeVersionId</key><value>${generateId()}</value></odeResource>
        <odeResource><key>odeId</key><value>${generateId()}</value></odeResource>
        <odeResource><key>odeVersionName</key><value>0</value></odeResource>
        <odeResource><key>isDownload</key><value>true</value></odeResource>
        <odeResource><key>eXeVersion</key><value>v3.0.2</value></odeResource>
    </odeResources>
    <odeProperties>
        <odeProperty><key>pp_title</key><value>${escapeHtml(packageTitle)}</value></odeProperty>
        <odeProperty><key>pp_subtitle</key><value>${escapeHtml(subtitle)}</value></odeProperty>
        <odeProperty><key>pp_lang</key><value>${escapeHtml(lang)}</value></odeProperty>
        <odeProperty><key>pp_author</key><value>${escapeHtml(author)}</value></odeProperty>
        <odeProperty><key>license</key><value>${escapeHtml(license)}</value></odeProperty>
        <odeProperty><key>pp_description</key><value>${escapeHtml(description)}</value></odeProperty>
        <odeProperty><key>exportSource</key><value>true</value></odeProperty>
        <odeProperty><key>pp_addExeLink</key><value>true</value></odeProperty>
        <odeProperty><key>pp_addPagination</key><value>false</value></odeProperty>
        <odeProperty><key>pp_addSearchBox</key><value>false</value></odeProperty>
        <odeProperty><key>pp_addAccessibilityToolbar</key><value>false</value></odeProperty>
        <odeProperty><key>pp_extraHeadContent</key><value></value></odeProperty>
        <odeProperty><key>footer</key><value></value></odeProperty>
    </odeProperties>
    <odeNavStructures>
`;

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const parentId = page.parent ? page.parent.id : '';
        xml += `        <odeNavStructure>
            <odePageId>${page.id}</odePageId>
            <odeParentPageId>${parentId}</odeParentPageId>
            <pageName>${escapeHtml(page.title)}</pageName>
            <odeNavStructureOrder>${i + 1}</odeNavStructureOrder>
            <odeNavStructureProperties>
                <odeNavStructureProperty><key>titlePage</key><value>${escapeHtml(page.title)}</value></odeNavStructureProperty>
                <odeNavStructureProperty><key>titleNode</key><value>${escapeHtml(page.title)}</value></odeNavStructureProperty>
                <odeNavStructureProperty><key>hidePageTitle</key><value>false</value></odeNavStructureProperty>
                <odeNavStructureProperty><key>titleHtml</key><value></value></odeNavStructureProperty>
                <odeNavStructureProperty><key>editableInPage</key><value>false</value></odeNavStructureProperty>
                <odeNavStructureProperty><key>visibility</key><value>true</value></odeNavStructureProperty>
                <odeNavStructureProperty><key>highlight</key><value>false</value></odeNavStructureProperty>
                <odeNavStructureProperty><key>description</key><value></value></odeNavStructureProperty>
            </odeNavStructureProperties>
            <odePagStructures>
`;
        for (let j = 0; j < page.sections.length; j++) {
            const sec = page.sections[j];
            const icon = getIconForSection(sec.title);
            const rawSecHtml = sec.contentHtml || '';

            // Process image and link paths for XML format inside content.xml (dummy zip writer since we copy during /elpx generation)
            const xmlContent = processResourcesInContent(rawSecHtml, sec.componentId, null, workspaceDir, '', true);

            const parsedIdevice = parseIdeviceHtml(xmlContent);
            
            let compId = sec.componentId;
            let compType = 'text';
            let htmlViewContent = `<div class="exe-text-template"><div class="textIdeviceContent"><div class="exe-text-activity"><div>${xmlContent}</div></div></div></div>`;
            let jsonPropsString = JSON.stringify({
                ideviceId: sec.componentId,
                textTextarea: xmlContent,
                textFeedbackInput: 'Mostra la retroacció',
                textFeedbackTextarea: ''
            });

            if (parsedIdevice.isIdevice) {
                compId = parsedIdevice.id || sec.componentId;
                compType = parsedIdevice.type || 'text';
                
                let innerHtml = parsedIdevice.innerHtml;
                if (compType === 'download-source-file') {
                    innerHtml = innerHtml.replace(/<a\s+([^>]*?onclick=["']if\(typeof downloadElpx==='function'\)downloadElpx\(\);return false;["'][^>]*?)>/gi, (m, attrs) => {
                        let cleanAttrs = attrs
                            .replace(/\bonclick=(?:"[^"]*"|'[^']*')/gi, '')
                            .replace(/\bdownload=(?:"[^"]*"|'[^']*')/gi, '')
                            .replace(/\bhref=(?:"[^"]*"|'[^']*')/gi, '');
                        return `<a download="exe-package:elp-name" href="exe-package:elp" ${cleanAttrs.trim()}>`;
                    });
                }
                htmlViewContent = innerHtml;
                jsonPropsString = '';
            }

            xml += `                <odePagStructure>
                    <odePageId>${page.id}</odePageId>
                    <odeBlockId>${sec.blockId}</odeBlockId>
                    <blockName>${escapeHtml(sec.title) || ' '}</blockName>
                    <iconName>${icon.replace('.png', '')}</iconName>
                    <odePagStructureOrder>${j + 1}</odePagStructureOrder>
                    <odePagStructureProperties>
                        <odePagStructureProperty><key>visibility</key><value>true</value></odePagStructureProperty>
                        <odePagStructureProperty><key>teacherOnly</key><value>false</value></odePagStructureProperty>
                        <odePagStructureProperty><key>allowToggle</key><value>true</value></odePagStructureProperty>
                        <odePagStructureProperty><key>minimized</key><value>false</value></odePagStructureProperty>
                        <odePagStructureProperty><key>identifier</key><value></value></odePagStructureProperty>
                        <odePagStructureProperty><key>cssClass</key><value></value></odePagStructureProperty>
                    </odePagStructureProperties>
                    <odeComponents>
                        <odeComponent>
                            <odePageId>${page.id}</odePageId>
                            <odeBlockId>${sec.blockId}</odeBlockId>
                            <odeIdeviceId>${compId}</odeIdeviceId>
                            <odeIdeviceTypeName>${compType}</odeIdeviceTypeName>
                            <htmlView>${escapeHtml(htmlViewContent)}</htmlView>
                            <jsonProperties>${jsonPropsString ? escapeHtml(jsonPropsString) : ''}</jsonProperties>
                            <odeComponentsOrder>1</odeComponentsOrder>
                            <odeComponentsProperties>
                                <odeComponentsProperty><key>visibility</key><value>true</value></odeComponentsProperty>
                                <odeComponentsProperty><key>teacherOnly</key><value>false</value></odeComponentsProperty>
                                <odeComponentsProperty><key>identifier</key><value></value></odeComponentsProperty>
                                <odeComponentsProperty><key>cssClass</key><value></value></odeComponentsProperty>
                            </odeComponentsProperties>
                        </odeComponent>
                    </odeComponents>
                </odePagStructure>
`;
        }
        xml += `            </odePagStructures>\n        </odeNavStructure>\n`;
    }

    xml += `    </odeNavStructures>\n</ode>\n`;
    return xml;
}

// In-memory compiler main entry point
function compileWorkspaceFile(filePath: string, context: vscode.ExtensionContext, updateTimestamp: boolean = true) {
    try {
        outputChannel.appendLine(`[Compiler] Compilando archivo: ${filePath}`);
        const source = fs.readFileSync(filePath, 'utf-8');
        const workspaceDir = path.dirname(filePath);

        // 0. Load _aliases.js if exists in workspaceDir/.config/components/ or config/components/
        let aliasesModule: any = null;
        try {
            let aliasesPath = path.join(workspaceDir, '.config', 'components', '_aliases.js');
            if (!fs.existsSync(aliasesPath)) {
                aliasesPath = path.join(workspaceDir, 'config', 'components', '_aliases.js');
            }
            if (!fs.existsSync(aliasesPath)) {
                aliasesPath = path.join(workspaceDir, 'components', '_aliases.js');
            }
            if (fs.existsSync(aliasesPath)) {
                const resolved = require.resolve(aliasesPath);
                delete require.cache[resolved];
                aliasesModule = require(aliasesPath);
            }
        } catch (err: any) {
            outputChannel.appendLine(`[Compiler] Error al cargar _aliases.js: ${err.message}`);
        }

        // 1. Parse .edu structure
        const { metadata, pages } = parseEdumark(source, aliasesModule);
        compiledPagesList = pages;
        compiledMetadata = metadata;

        // 2. Read base index.html template from disk
        const templatePath = path.join(context.extensionPath, 'template', 'index.html');
        if (!fs.existsSync(templatePath)) {
            throw new Error(`No se encontró la plantilla eXeLearning en ${templatePath}`);
        }
        const templateHtml = fs.readFileSync(templatePath, 'utf-8');

        // 3. Update last update timestamp first to prevent race condition
        if (updateTimestamp) {
            lastUpdateTimestamp = Date.now();
        }

        // 4. Compile in-memory HTML pages (with hot-reload script injected)
        inMemoryPages = compileToHtmlPages(pages, metadata, templateHtml, workspaceDir, true);

        outputChannel.appendLine(`[Compiler] Compilación exitosa. ${pages.length} páginas generadas en memoria.`);
    } catch (err: any) {
        outputChannel.appendLine(`[Compiler] ERROR en compilación: ${err.message}`);
        vscode.window.showErrorMessage(`Error al previsualizar Edumark: ${err.message}`);
    }
}

// Custom Content Type helper for http server
function getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.html': return 'text/html; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        case '.js': return 'application/javascript; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        case '.png': return 'image/png';
        case '.jpg': case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.svg': return 'image/svg+xml';
        case '.ico': return 'image/x-icon';
        case '.pdf': return 'application/pdf';
        default: return 'application/octet-stream';
    }
}

// HTTP Server starter returning Promise with real listening port
function startServer(context: vscode.ExtensionContext): Promise<number> {
    return new Promise((resolve) => {
        if (server) {
            resolve(serverPort);
            return;
        }

        server = http.createServer((req, res) => {
            const decodedUrl = decodeURIComponent(req.url || '/');
            if (decodedUrl !== '/status') {
                outputChannel.appendLine(`[Server] Request: ${decodedUrl}`);
            }

        // Route 1: Status endpoint for polling hot reload
        if (decodedUrl === '/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ last_update: lastUpdateTimestamp }));
            return;
        }

        // Route 2: Download .elpx on the fly
        if (decodedUrl === '/elpx') {
            try {
                const zip = new AdmZip();
                const workspaceDir = path.dirname(activeDocumentPath);
                const templateDir = path.join(context.extensionPath, 'template');

                // 2.1 Bundle eXeLearning libraries and core widgets
                for (const folder of ['libs', 'idevices', 'custom']) {
                    const folderPath = path.join(templateDir, folder);
                    if (fs.existsSync(folderPath)) {
                        zip.addLocalFolder(folderPath, folder);
                    }
                }

                // Bundle theme: prioritize workspace custom theme over extension template base theme
                const workspaceThemePath = path.join(workspaceDir, 'theme');
                if (fs.existsSync(workspaceThemePath) && fs.statSync(workspaceThemePath).isDirectory()) {
                    zip.addLocalFolder(workspaceThemePath, 'theme');
                    outputChannel.appendLine('[Packager] Bundling custom theme from workspace.');
                } else {
                    const templateThemePath = path.join(templateDir, 'theme');
                    if (fs.existsSync(templateThemePath)) {
                        zip.addLocalFolder(templateThemePath, 'theme');
                    }
                }

                // 2.2 Recompile final production pages (WITHOUT hot-reload script!)
                const templateHtml = fs.readFileSync(path.join(templateDir, 'index.html'), 'utf-8');
                const productionPages = compileToHtmlPages(compiledPagesList, compiledMetadata, templateHtml, workspaceDir, false);

                // 2.3 Copy compiled static pages and bundle workspace resources (images/files) directly into zip
                for (const filename of Object.keys(productionPages)) {
                    let pageHtml = productionPages[filename];
                    
                    // Bundle and link any assets inside each page content
                    const isSubpage = filename !== 'index.html';
                    const relPrefix = isSubpage ? '../' : '';
                    
                    for (const page of compiledPagesList) {
                        if (page.filename === filename) {
                            for (const sec of page.sections) {
                                pageHtml = processResourcesInContent(pageHtml, sec.componentId, zip, workspaceDir, relPrefix, false);
                            }
                        }
                    }

                    zip.addFile(filename, Buffer.from(pageHtml, 'utf-8'));
                }

                // 2.4 Generate and add content.xml manifest with bundled resource links
                const themePath = path.join(workspaceDir, 'theme');
                
                let themeName = 'base';
                if (fs.existsSync(themePath) && fs.statSync(themePath).isDirectory()) {
                    themeName = extractThemeName(themePath);
                }
                const contentXml = generateContentXml(compiledPagesList, compiledMetadata, workspaceDir, themeName);
                zip.addFile('content.xml', Buffer.from(contentXml, 'utf-8'));

                // 2.5 Generate ZIP buffer and send to client
                const zipBuffer = zip.toBuffer();
                const safeName = generateSlug(compiledMetadata.titulo || 'proyecto') || 'proyecto';

                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="${safeName}.elpx"`,
                    'Content-Length': zipBuffer.length
                });
                res.end(zipBuffer);
                outputChannel.appendLine(`[Server] ELPX zip generado exitosamente.`);
            } catch (err: any) {
                outputChannel.appendLine(`[Server] Error generando ELPX zip: ${err.message}`);
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Error al generar el paquete eXeLearning: ${err.message}`);
            }
            return;
        }

        // Route 3: Dynamic In-memory HTML preview pages
        // We trim leading slash
        let cleanUrl = decodedUrl.substring(1);
        if (cleanUrl === '' || cleanUrl === 'index.html') {
            cleanUrl = 'index.html';
        }

        // Recompile workspace on manual index.html reloads WITHOUT updating timestamp to prevent loop!
        if (cleanUrl === 'index.html' && activeDocumentPath) {
            compileWorkspaceFile(activeDocumentPath, context, false);
        }

        if (inMemoryPages[cleanUrl]) {
            // We append a Download float bar in preview mode to let the user export .elpx instantly!
            let html = inMemoryPages[cleanUrl];
            const downloadFloatBar = `
            <div id="edumark-download-bar" style="position: fixed; bottom: 20px; left: 20px; z-index: 9999; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: #ffffff; padding: 10px 20px; border-radius: 30px; box-shadow: 0 10px 25px rgba(29, 78, 216, 0.4); font-family: sans-serif; font-size: 14px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 8px; transition: transform 0.2s ease, box-shadow 0.2s ease;" onclick="window.location.href='/elpx'">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                <span>elpx</span>
            </div>
            <style>
                #edumark-download-bar:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 12px 30px rgba(29, 78, 216, 0.5);
                }
            </style>
            `;
            if (html.includes('</body>')) {
                html = html.replace('</body>', `${downloadFloatBar}\n</body>`);
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        }

        // Route 4: Resolve and serve workspace-local assets (images, PDFs, custom theme) FIRST
        if (activeDocumentPath) {
            const workspaceDir = path.dirname(activeDocumentPath);
            let assetRelativeName = cleanUrl;
            
            // Subpages inside html/ might fetch images as html/portada.png, so strip html/ prefix
            if (assetRelativeName.startsWith('html/')) {
                assetRelativeName = assetRelativeName.substring(5);
            }

            // In preview mode, resource assets have been compiled to relative paths (e.g. content/resources/componentId/filename)
            // Resolve them to the raw asset filename directly inside the workspace root
            if (assetRelativeName.includes('content/resources/')) {
                assetRelativeName = path.basename(assetRelativeName);
            }

            const workspaceAssetPath = path.join(workspaceDir, assetRelativeName);
            if (fs.existsSync(workspaceAssetPath) && fs.statSync(workspaceAssetPath).isFile()) {
                res.writeHead(200, { 'Content-Type': getContentType(workspaceAssetPath) });
                fs.createReadStream(workspaceAssetPath).pipe(res);
                return;
            }
        }

        // Route 5: Serve template static assets from disk (libs, theme, idevices, custom) as fallback
        const templateDir = path.join(context.extensionPath, 'template');
        const templateAssetPath = path.join(templateDir, cleanUrl);

        if (fs.existsSync(templateAssetPath) && fs.statSync(templateAssetPath).isFile()) {
            res.writeHead(200, { 'Content-Type': getContentType(templateAssetPath) });
            fs.createReadStream(templateAssetPath).pipe(res);
            return;
        }

        // 404 Not Found fallback
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No se pudo encontrar el recurso solicitado por Edumark.');
    });

        // Listen on dynamic ephemeral port
        server.listen(0, '127.0.0.1', () => {
            const address = server!.address();
            if (address && typeof address !== 'string') {
                serverPort = address.port;
                outputChannel.appendLine(`[Server] Servidor HTTP local iniciado en http://127.0.0.1:${serverPort}`);
                resolve(serverPort);
            } else {
                resolve(0);
            }
        });
    });
}

// Extension Activator
export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Edumark to eXeLearning');
    outputChannel.show();
    outputChannel.appendLine('Activando extensión edu2elpx...');
    extensionPath = context.extensionPath;

    // 1. Register the preview command
    const previewCommand = vscode.commands.registerCommand('edu2elpx.preview', () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showErrorMessage('Por favor, abre un archivo Edumark (.edu) para previsualizarlo.');
            return;
        }

        const docPath = activeEditor.document.uri.fsPath;
        if (path.extname(docPath).toLowerCase() !== '.edu') {
            vscode.window.showErrorMessage('Solo se pueden previsualizar archivos de Edumark (.edu).');
            return;
        }

        activeDocumentPath = docPath;

        // Start server if not running, wait for listen port, then compile and open preview
        startServer(context).then((port) => {
            // Compile active file
            compileWorkspaceFile(docPath, context);

            // Open preview page in external default browser
            const previewUrl = `http://127.0.0.1:${port}/index.html`;
            vscode.env.openExternal(vscode.Uri.parse(previewUrl));
            vscode.window.showInformationMessage(`Visualizando en tiempo real: ${path.basename(docPath)}`);
        });
    });

    context.subscriptions.push(previewCommand);

    // 2. Watch text document saves to auto-reload dynamically
    const saveWatcher = vscode.workspace.onDidSaveTextDocument((doc) => {
        if (path.extname(doc.uri.fsPath).toLowerCase() === '.edu') {
            outputChannel.appendLine(`[Watcher] Cambio detectado en guardar archivo: ${doc.uri.fsPath}`);
            activeDocumentPath = doc.uri.fsPath;
            compileWorkspaceFile(doc.uri.fsPath, context);
        }
    });

    context.subscriptions.push(saveWatcher);

    // 3. Watch real-time changes inside the editor with a 600ms debounce to prevent constant flashing while typing
    let changeTimer: NodeJS.Timeout | null = null;
    const changeWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
        if (path.extname(event.document.uri.fsPath).toLowerCase() === '.edu') {
            activeDocumentPath = event.document.uri.fsPath;
            if (changeTimer) {
                clearTimeout(changeTimer);
            }
            changeTimer = setTimeout(() => {
                compileWorkspaceFile(event.document.uri.fsPath, context);
            }, 600);
        }
    });

    context.subscriptions.push(changeWatcher);
}

// Extension Deactivator
export function deactivate() {
    if (server) {
        server.close();
        outputChannel.appendLine('[Server] Servidor HTTP local apagado.');
    }
}

// Geometric/ASCII Table processing and rendering logic

interface TableCell {
  id: string;
  row: number;
  column: number;
  rowspan: number;
  colspan: number;
  content: string[];
}

interface TableNode {
  type: 'table';
  rowsCount: number;
  colsCount: number;
  cells: TableCell[];
  isRubric?: boolean;
  colWidths?: number[];
}

class DSU {
  parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    if (this.parent[i] === i) return i;
    this.parent[i] = this.find(this.parent[i]);
    return this.parent[i];
  }

  union(i: number, j: number) {
    const rootI = this.find(i);
    const rootJ = this.find(j);
    if (rootI !== rootJ) {
      this.parent[rootI] = rootJ;
    }
  }
}

function parseGeometricTable(tableStr: string, isRubric = false, preserveEmptyLines = false, autoCorrectPipes = false): TableNode {
  const rawLines = tableStr.split(/\r?\n/).map(line => line.trimEnd());
  const lines = rawLines.filter(line => line.length > 0);
  if (lines.length === 0) {
    return { type: 'table', rowsCount: 0, colsCount: 0, cells: [], isRubric };
  }

  const maxLength = Math.max(...lines.map(line => line.length));
  const grid = lines.map(line => line.padEnd(maxLength, ' '));

  const hLines: number[] = [];
  for (let r = 0; r < grid.length; r++) {
    const rowStr = grid[r];
    const isBorderRow =
      /^[|+\-\s=_]+$/.test(rowStr) &&
      (/[-=_]/.test(rowStr) || rowStr.includes('+'));
    if (isBorderRow) {
      hLines.push(r);
    }
  }

  if (hLines.length < 2) {
    return { type: 'table', rowsCount: 0, colsCount: 0, cells: [], isRubric };
  }

  const vLinesSet = new Set<number>();
  for (const r of hLines) {
    const rowStr = grid[r];
    for (let c = 0; c < rowStr.length; c++) {
      if (rowStr[c] === '|' || rowStr[c] === '+') {
        vLinesSet.add(c);
      }
    }
  }
  const vLines = Array.from(vLinesSet).sort((a, b) => a - b);

  if (vLines.length < 2) {
    return { type: 'table', rowsCount: 0, colsCount: 0, cells: [], isRubric };
  }

  const H = hLines.length;
  const V = vLines.length;

  if (autoCorrectPipes) {
    for (let j = 0; j < H - 1; j++) {
      const upperBorderRow = hLines[j];
      const lowerBorderRow = hLines[j + 1];
      const rStart = upperBorderRow + 1;
      const rEnd = lowerBorderRow - 1;

      for (let r = rStart; r <= rEnd; r++) {
        let line = grid[r];
        const lineVLines: number[] = [];
        for (let c = 0; c < line.length; c++) {
          if (line[c] === '|') {
            lineVLines.push(c);
          }
        }

        if (lineVLines.length < V) {
          const boundaryPos = Array(V).fill(-1);
          for (const s of lineVLines) {
            let closestIdx = 0;
            let minDiff = Math.abs(s - vLines[0]);
            for (let vIdx = 1; vIdx < V; vIdx++) {
              const diff = Math.abs(s - vLines[vIdx]);
              if (diff < minDiff) {
                minDiff = diff;
                closestIdx = vIdx;
              }
            }
            boundaryPos[closestIdx] = s;
          }

          let lineChanged = false;
          for (let i = 0; i < V; i++) {
            if (boundaryPos[i] === -1) {
              const v = vLines[i];
              const upperHasSep = upperBorderRow < grid.length && v < grid[upperBorderRow].length && 
                (grid[upperBorderRow][v] === '|' || grid[upperBorderRow][v] === '+');
              const lowerHasSep = lowerBorderRow < grid.length && v < grid[lowerBorderRow].length && 
                (grid[lowerBorderRow][v] === '|' || grid[lowerBorderRow][v] === '+');
              
              if (upperHasSep && lowerHasSep) {
                if (v < line.length) {
                  if (line[v] !== '|') {
                    line = line.substring(0, v) + '|' + line.substring(v + 1);
                    lineChanged = true;
                  }
                } else {
                  line = line.padEnd(v, ' ') + '|';
                  lineChanged = true;
                }
              }
            }
          }

          if (lineChanged) {
            grid[r] = line;
          }
        }
      }
    }
  }

  const rowIntervalsCount = H - 1;
  const colIntervalsCount = V - 1;

  const getUnitId = (j: number, i: number) => j * colIntervalsCount + i;
  const dsu = new DSU(rowIntervalsCount * colIntervalsCount);

  for (let j = 0; j < rowIntervalsCount; j++) {
    const rStart = hLines[j] + 1;
    const rEnd = hLines[j + 1] - 1;

    const activeBoundaries = new Set<number>();
    if (rStart > rEnd) {
      let targetJ = -1;
      if (j > 0) {
        targetJ = j - 1;
      } else if (rowIntervalsCount > 1) {
        targetJ = j + 1;
      }

      if (targetJ !== -1) {
        const adjStart = hLines[targetJ] + 1;
        const adjEnd = hLines[targetJ + 1] - 1;
        for (let r = adjStart; r <= adjEnd; r++) {
          const lineText = grid[r];
          const lineVLines: number[] = [];
          for (let c = 0; c < lineText.length; c++) {
            if (lineText[c] === '|') {
              lineVLines.push(c);
            }
          }
          if (lineVLines.length >= 2) {
            if (lineVLines.length >= vLines.length) {
              for (let idx = 1; idx < lineVLines.length - 1; idx++) {
                const s = lineVLines[idx];
                if (vLines.length > 2) {
                  let closestVal = vLines[1];
                  let minDiff = Math.abs(s - vLines[1]);
                  for (let vIdx = 2; vIdx < vLines.length - 1; vIdx++) {
                    const diff = Math.abs(s - vLines[vIdx]);
                    if (diff < minDiff) {
                      minDiff = diff;
                      closestVal = vLines[vIdx];
                    }
                  }
                  activeBoundaries.add(closestVal);
                }
              }
            } else {
              for (const s of lineVLines) {
                let closestVal = vLines[0];
                let minDiff = Math.abs(s - vLines[0]);
                for (let vIdx = 1; vIdx < vLines.length; vIdx++) {
                  const diff = Math.abs(s - vLines[vIdx]);
                  if (diff < minDiff) {
                    minDiff = diff;
                    closestVal = vLines[vIdx];
                  }
                }
                if (closestVal !== vLines[0] && closestVal !== vLines[vLines.length - 1]) {
                  activeBoundaries.add(closestVal);
                }
              }
            }
          }
        }
      } else {
        for (const v of vLines) {
          activeBoundaries.add(v);
        }
      }
    } else {
      for (let r = rStart; r <= rEnd; r++) {
        const lineText = grid[r];
        const lineVLines: number[] = [];
        for (let c = 0; c < lineText.length; c++) {
          if (lineText[c] === '|') {
            lineVLines.push(c);
          }
        }

        if (lineVLines.length >= 2) {
          if (lineVLines.length >= vLines.length) {
            for (let idx = 1; idx < lineVLines.length - 1; idx++) {
              const s = lineVLines[idx];
              if (vLines.length > 2) {
                let closestVal = vLines[1];
                let minDiff = Math.abs(s - vLines[1]);
                for (let vIdx = 2; vIdx < vLines.length - 1; vIdx++) {
                  const diff = Math.abs(s - vLines[vIdx]);
                  if (diff < minDiff) {
                    minDiff = diff;
                    closestVal = vLines[vIdx];
                  }
                }
                activeBoundaries.add(closestVal);
              }
            }
          } else {
            for (const s of lineVLines) {
              let closestVal = vLines[0];
              let minDiff = Math.abs(s - vLines[0]);
              for (let vIdx = 1; vIdx < vLines.length; vIdx++) {
                const diff = Math.abs(s - vLines[vIdx]);
                if (diff < minDiff) {
                  minDiff = diff;
                  closestVal = vLines[vIdx];
                }
              }
              if (closestVal !== vLines[0] && closestVal !== vLines[vLines.length - 1]) {
                activeBoundaries.add(closestVal);
              }
            }
          }
        }
      }
    }

    for (let i = 0; i < colIntervalsCount - 1; i++) {
      const boundaryColVal = vLines[i + 1];
      if (!activeBoundaries.has(boundaryColVal)) {
        dsu.union(getUnitId(j, i), getUnitId(j, i + 1));
      }
    }
  }

  for (let j = 0; j < rowIntervalsCount - 1; j++) {
    const boundaryRow = hLines[j + 1];

    for (let i = 0; i < colIntervalsCount; i++) {
      const cStart = vLines[i] + 1;
      const cEnd = vLines[i + 1] - 1;

      let borderExists = false;
      for (let c = cStart; c <= cEnd; c++) {
        const char = grid[boundaryRow][c];
        if (char === '-' || char === '=' || char === '+' || char === '_') {
          borderExists = true;
          break;
        }
      }

      if (!borderExists) {
        dsu.union(getUnitId(j, i), getUnitId(j + 1, i));
      }
    }
  }

  const groups = new Map<number, { j: number; i: number }[]>();
  for (let j = 0; j < rowIntervalsCount; j++) {
    for (let i = 0; i < colIntervalsCount; i++) {
      const unitId = getUnitId(j, i);
      const root = dsu.find(unitId);
      if (!groups.has(root)) {
        groups.set(root, []);
      }
      groups.get(root)!.push({ j, i });
    }
  }

  const cells: TableCell[] = [];
  let cellCounter = 1;

  const finalGroups: { j: number; i: number }[][] = [];
  for (const group of groups.values()) {
    const minJ = Math.min(...group.map(g => g.j));
    const maxJ = Math.max(...group.map(g => g.j));
    const minI = Math.min(...group.map(g => g.i));
    const maxI = Math.max(...group.map(g => g.i));
    const rowspan = maxJ - minJ + 1;
    const colspan = maxI - minI + 1;

    if (group.length === rowspan * colspan) {
      finalGroups.push(group);
    } else {
      for (const unit of group) {
        finalGroups.push([unit]);
      }
    }
  }

  for (const group of finalGroups) {
    const minJ = Math.min(...group.map(g => g.j));
    const maxJ = Math.max(...group.map(g => g.j));
    const minI = Math.min(...group.map(g => g.i));
    const maxI = Math.max(...group.map(g => g.i));

    const rowspan = maxJ - minJ + 1;
    const colspan = maxI - minI + 1;

    const contentLines: string[] = [];

    for (let j = minJ; j <= maxJ; j++) {
      const rStart = hLines[j] + 1;
      const rEnd = hLines[j + 1] - 1;
      for (let r = rStart; r <= rEnd; r++) {
        const lineText = grid[r];
        const lineVLines: number[] = [];
        for (let c = 0; c < lineText.length; c++) {
          if (lineText[c] === '|') {
            lineVLines.push(c);
          }
        }

        let slice = '';
        if (lineVLines.length >= 2) {
          const boundaryPos = Array(vLines.length).fill(-1);
          if (lineVLines.length >= vLines.length) {
            boundaryPos[0] = lineVLines[0];
            boundaryPos[vLines.length - 1] = lineVLines[lineVLines.length - 1];

            for (let idx = 1; idx < lineVLines.length - 1; idx++) {
              const s = lineVLines[idx];
              if (vLines.length > 2) {
                let closestIdx = 1;
                let minDiff = Math.abs(s - vLines[1]);
                for (let vIdx = 2; vIdx < vLines.length - 1; vIdx++) {
                  const diff = Math.abs(s - vLines[vIdx]);
                  if (diff < minDiff) {
                    minDiff = diff;
                    closestIdx = vIdx;
                  }
                }
                boundaryPos[closestIdx] = s;
              }
            }
          } else {
            for (const s of lineVLines) {
              let closestIdx = 0;
              let minDiff = Math.abs(s - vLines[0]);
              for (let vIdx = 1; vIdx < vLines.length; vIdx++) {
                const diff = Math.abs(s - vLines[vIdx]);
                if (diff < minDiff) {
                  minDiff = diff;
                  closestIdx = vIdx;
                }
              }
              boundaryPos[closestIdx] = s;
            }
          }

          const startPos = boundaryPos[minI];
          const endPos = boundaryPos[maxI + 1];

          if (startPos !== -1 && endPos !== -1) {
            slice = lineText.substring(startPos + 1, endPos);
          } else {
            const colStart = vLines[minI] + 1;
            const colEnd = vLines[maxI + 1] - 1;
            slice = lineText.substring(colStart, colEnd + 1);
          }
        } else {
          const colStart = vLines[minI] + 1;
          const colEnd = vLines[maxI + 1] - 1;
          slice = lineText.substring(colStart, colEnd + 1);
        }

        contentLines.push(slice);
      }
    }

    const processedLines = [...contentLines];

    let minLeadingSpaces = Infinity;
    for (const line of processedLines) {
      if (line.trim() !== '') {
        const match = line.match(/^( *)/);
        const leading = match ? match[1].length : 0;
        if (leading < minLeadingSpaces) {
          minLeadingSpaces = leading;
        }
      }
    }
    if (minLeadingSpaces === Infinity) {
      minLeadingSpaces = 0;
    }
    if (minLeadingSpaces > 1) {
      minLeadingSpaces = 1;
    }

    const finalContent = processedLines.map(line => {
      if (line.trim() === '') return '';
      const leftStripped = line.substring(minLeadingSpaces);
      return leftStripped.trimEnd();
    });

    if (!preserveEmptyLines) {
      while (finalContent.length > 0 && finalContent[finalContent.length - 1] === '') {
        finalContent.pop();
      }
      while (finalContent.length > 0 && finalContent[0] === '') {
        finalContent.shift();
      }
    }

    cells.push({
      id: `cell-${cellCounter++}`,
      row: minJ,
      column: minI,
      rowspan,
      colspan,
      content: finalContent
    });
  }

  const colWidths: number[] = [];
  for (let i = 0; i < colIntervalsCount; i++) {
    colWidths.push(vLines[i + 1] - vLines[i] - 1);
  }

  return {
    type: 'table',
    rowsCount: rowIntervalsCount,
    colsCount: colIntervalsCount,
    cells,
    isRubric,
    colWidths
  };
}

function geometricTableToHtml(table: TableNode): string {
    const rows = table.rowsCount;
    const cols = table.colsCount;
    const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
    
    let html = '<table class="exe-table">\n';
    
    const findCell = (r: number, c: number) => {
        return table.cells.find(cell => cell.row === r && cell.column === c);
    };

    for (let r = 0; r < rows; r++) {
        html += '  <tr>\n';
        for (let c = 0; c < cols; c++) {
            if (visited[r][c]) {
                continue;
            }
            const cell = findCell(r, c);
            if (cell) {
                for (let h = 0; h < cell.rowspan; h++) {
                    for (let w = 0; w < cell.colspan; w++) {
                        if (r + h < rows && c + w < cols) {
                            visited[r + h][c + w] = true;
                        }
                    }
                }
                
                const tag = r === 0 ? 'th' : 'td';
                const cellContent = cell.content.join('\n').trim();
                const innerHtml = compileMarkdown(cellContent).trim();
                
                let cleanInnerHtml = innerHtml;
                if (cleanInnerHtml.startsWith('<p>') && cleanInnerHtml.endsWith('</p>')) {
                    const inner = cleanInnerHtml.substring(3, cleanInnerHtml.length - 4);
                    if (!inner.includes('<p>')) {
                        cleanInnerHtml = inner;
                    }
                }
                
                const rowspanAttr = cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '';
                const colspanAttr = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '';
                
                html += `    <${tag}${rowspanAttr}${colspanAttr}>${cleanInnerHtml}</${tag}>\n`;
            }
        }
        html += '  </tr>\n';
    }
    html += '</table>';
    return html;
}

function processGeometricTables(text: string): string {
    const lines = text.split(/\r?\n/);
    const newLines: string[] = [];
    let i = 0;
    
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        
        const isBorderRow = /^[|+\-\s=_]+$/.test(trimmed) && (/[-=_]/.test(trimmed) || trimmed.includes('+'));
        
        if (isBorderRow && trimmed.length > 2) {
            const tableLines: string[] = [line];
            let j = i + 1;
            let lastBorderIdx = i;
            
            while (j < lines.length) {
                const nextLine = lines[j];
                const nextTrimmed = nextLine.trim();
                
                const isNextBorder = /^[|+\-\s=_]+$/.test(nextTrimmed) && (/[-=_]/.test(nextTrimmed) || nextTrimmed.includes('+'));
                const isContentRow = nextTrimmed.startsWith('|') && nextTrimmed.endsWith('|');
                
                if (isNextBorder || isContentRow) {
                    tableLines.push(nextLine);
                    if (isNextBorder) {
                        lastBorderIdx = j;
                    }
                    j++;
                } else {
                    break;
                }
            }
            
            const HLinesCount = tableLines.filter(l => {
                const t = l.trim();
                return /^[|+\-\s=_]+$/.test(t) && (/[-=_]/.test(t) || t.includes('+'));
            }).length;
            
            if (HLinesCount >= 2 && lastBorderIdx >= i + 2) {
                const validTableLines = lines.slice(i, lastBorderIdx + 1);
                const tableStr = validTableLines.join('\n');
                
                try {
                    const tableNode = parseGeometricTable(tableStr, false, false, true);
                    if (tableNode && tableNode.cells.length > 0) {
                        const htmlTable = geometricTableToHtml(tableNode);
                        newLines.push(htmlTable);
                        i = lastBorderIdx + 1;
                        continue;
                    }
                } catch (e) {
                    // Fallback
                }
            }
        }
        
        newLines.push(line);
        i++;
    }
    
    return newLines.join('\n');
}
