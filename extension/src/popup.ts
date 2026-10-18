// The toolbar popup.
import { send } from './adapters/chrome/messages';
import { showAccount, showLogin } from './ui/popupView';

const app = document.getElementById('app')!;

async function refresh() {
  const me = await send({ type: 'me' });
  if (me.ok && me.data) await showAccount(app, me.data);
  else await showLogin(app);
}

// Signing in or out, here or from the panel on YouTube, switches the view.
chrome.storage.onChanged.addListener(changes => {
  if (changes.token) void refresh();
});

void refresh();
