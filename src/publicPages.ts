import { renderMarkdown } from './utils/markdown'

const PARRHESIA_ASCII = `


                                         ,---,
,-.----.                               ,--.' |                            ,--,
\\    /  \\              __  ,-.  __  ,-.|  |  :                          ,--.'|
|   :    |           ,' ,'/ /|,' ,'/ /|:  :  :                .--.--.   |  |,
|   | .\\ :  ,--.--.  '  | |' |'  | |' |:  |  |,--.   ,---.   /  /    '  \`--'_      ,--.--.
.   : |: | /       \\ |  |   ,'|  |   ,'|  :  '   |  /     \\ |  :  /\`./  ,' ,'|    /       \\
|   |  \\ :.--.  .-. |'  :  /  '  :  /  |  |   /' : /    /  ||  :  ;_    '  | |   .--.  .-. |
|   : .  | \\__\\/: . .|  | '   |  | '   '  :  | | |.    ' / | \\  \\    \`. |  | :    \\__\\/: . .
:     |\`-' ," .--.; |;  : |   ;  : |   |  |  ' | :'   ;   /|  \`----.   \\'  : |__  ," .--.; |
:   : :   /  /  ,.  ||  , ;   |  , ;   |  :  :_:,''   |  / | /  /\`--'  /|  | '.'|/  /  ,.  |
|   | :  ;  :   .'   \\---'     ---'    |  | ,'    |   :    |'--'.     / ;  :    ;  :   .'   \\
\`---'.|  |  ,     .-./                 \`--''       \\   \\  /   \`--'---'  |  ,   /|  ,     .-./
  \`---\`   \`--\`---'                                  \`----'               ---\`-'  \`--\`---'`

interface LandingOptions {
  disabled?: boolean
  inert?: boolean
  status?: boolean
  theme?: 'light' | 'dark'
}

export function renderLandingPage(markdown: string, options: LandingOptions = {}): string {
  return `
    <main class="landing" ${options.inert ? 'inert' : ''}>
      <pre class="crow" aria-hidden="true">${PARRHESIA_ASCII}</pre>
      <img class="mobile-mark" src="/favicon/favicon.svg" alt="" width="128" height="128">
      <div class="subtitle">${renderMarkdown('*Loquere libere; nihil manet.*')}</div>
      <hr>
      <div class="actions">
        <div class="room-fields">
          <input type="text" id="room-input" placeholder="room id" aria-label="Room ID" ${options.disabled ? 'disabled' : ''}>
          <input type="password" id="room-password" placeholder="password (optional)" aria-label="Room password (optional)" autocomplete="current-password" ${options.disabled ? 'disabled' : ''}>
        </div>
        <button id="join-room" ${options.disabled ? 'disabled' : ''}>Join</button>
        <span class="or">or</span>
        <button id="create-room" ${options.disabled ? 'disabled' : ''}>Create Room</button>
      </div>
      ${options.status ? '<p role="status"><b>Status:</b> <span id="room-status"></span></p>' : ''}
      <noscript><p>JavaScript is required to create or join a room.</p></noscript>
      <article class="home-content terms-content">${renderMarkdown(markdown)}</article>
      <footer class="footer-links">
        <nav class="footer-row" aria-label="Public pages">
          <button type="button" id="source-toggle" class="link-button" aria-expanded="false" aria-controls="source-links">source code</button>
          <a href="/terms/" class="terms-link">terms</a>
          <div class="theme-toggle">
            <button type="button" id="theme-toggle" class="link-button">${options.theme ?? 'light'}</button>
          </div>
        </nav>
        <div class="source-links" id="source-links">
          <a href="https://github.com/longestneckedgiraffe/parrhesia-frontend">frontend</a>
          <a href="https://github.com/longestneckedgiraffe/parrhesia-backend">backend</a>
        </div>
      </footer>
    </main>
  `
}

export function renderTermsPage(markdown: string, theme = 'light'): string {
  return `
    <main class="terms">
      <a href="/" class="back-link">back</a>
      <article class="terms-content">${renderMarkdown(markdown)}</article>
    </main>
    <div class="theme-toggle">
      <button type="button" id="theme-toggle" class="link-button">${theme}</button>
    </div>
  `
}
