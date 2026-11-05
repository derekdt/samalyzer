const { log, logError } = require('./util');

function maskCredential(value) {
  if (!value) return '(empty)';
  if (value.length <= 7) return `${'*'.repeat(value.length)} (len=${value.length})`;
  return `${value.slice(0, 3)}***${value.slice(-4)} (len=${value.length})`;
}

async function login(page, config) {
  const { baseUrl, loginPath, paywallMarker, navigationTimeoutMs } = config;
  const username = process.env.WP_USERNAME;
  const password = process.env.WP_PASSWORD;

  if (!username || !password) {
    throw new Error('Missing WP_USERNAME or WP_PASSWORD in .env');
  }

  const hasLeadingWs = /^\s/.test(username) || /^\s/.test(password);
  const hasTrailingWs = /\s$/.test(username) || /\s$/.test(password);
  log(`WP_USERNAME: ${maskCredential(username)}`);
  log(`WP_PASSWORD: ${maskCredential(password)}`);
  if (hasLeadingWs || hasTrailingWs) {
    log(
      `WARNING: credentials contain leading/trailing whitespace (leading=${hasLeadingWs}, trailing=${hasTrailingWs}) — check for stray spaces or quotes in .env`
    );
  }

  const loginUrl = `${baseUrl}${loginPath}`;
  log(`navigating to login: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });

  await page.waitForSelector('input[name="log"], #user_login', { timeout: navigationTimeoutMs });

  const userSel = (await page.$('input[name="log"]')) ? 'input[name="log"]' : '#user_login';
  const passSel = (await page.$('input[name="pwd"]')) ? 'input[name="pwd"]' : '#user_pass';

  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el && !el.disabled && el.offsetParent !== null;
    },
    { timeout: navigationTimeoutMs },
    userSel
  );

  const setFieldValue = async (selector, value) => {
    await page.$eval(
      selector,
      (el, v) => {
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      },
      value
    );
  };

  await setFieldValue(userSel, username);
  await setFieldValue(passSel, password);

  const typedUser = await page.$eval(userSel, (el) => el.value);
  const typedPass = await page.$eval(passSel, (el) => el.value);
  if (typedUser !== username || typedPass !== password) {
    throw new Error(
      `field mismatch before submit: user expected len=${username.length} got len=${typedUser.length}, password expected len=${password.length} got len=${typedPass.length}.`
    );
  }

  const rememberMe = await page.$('#rememberme, input[name="rememberme"]');
  if (rememberMe) {
    const isChecked = await page.evaluate((el) => el.checked, rememberMe);
    if (!isChecked) await rememberMe.click();
  }

  log('submitting login form');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }),
    page.click('#wp-submit, input[type="submit"][name="wp-submit"]'),
  ]);

  const errText = await page.evaluate(() => {
    const el = document.querySelector('#login_error, .login-error');
    return el ? el.innerText.trim() : null;
  });
  if (errText) {
    throw new Error(`Login failed: ${errText}`);
  }

  log('verifying authenticated session');
  const verified = await verifySession(page, config);
  if (!verified) {
    throw new Error(
      'Login appeared to submit, but session does not look authenticated. Check credentials in .env.'
    );
  }

  log('login verified');
}

async function verifySession(page, config) {
  const { baseUrl, archivePath, paywallMarker, navigationTimeoutMs } = config;
  try {
    await page.goto(`${baseUrl}${archivePath}`, {
      waitUntil: 'domcontentloaded',
      timeout: navigationTimeoutMs,
    });
    const html = await page.content();
    if (paywallMarker && html.includes(paywallMarker)) {
      return false;
    }
    const loggedInMarker = await page.evaluate(
      () =>
        Boolean(document.body && document.body.className.includes('logged-in')) ||
        Boolean(document.querySelector('#wpadminbar'))
    );
    if (loggedInMarker) return true;
    const hasLoginForm = await page.$('input[name="pwd"]');
    return !hasLoginForm;
  } catch (err) {
    logError(`session verification error: ${err.message}`);
    return false;
  }
}

module.exports = { login, verifySession };
