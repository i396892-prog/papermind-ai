import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './auth-config.js';

const $ = (selector) => document.querySelector(selector);
const set = (selector, value) => { const el = $(selector); if (el) el.textContent = value; };
const SUPABASE_JS_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export function initAuth(t) {
  const dialog = $('#authDialog');
  const form = $('#authForm');
  const email = $('#authEmail');
  const password = $('#authPassword');
  const confirmPassword = $('#authConfirmPassword');
  const submit = $('#authSubmit');
  const message = $('#authMessage');
  const setupNotice = $('#authSetupNotice');
  let client;
  let mode = 'signin';
  let session = null;
  let busy = false;

  const hasValidConfig = () => {
    const url = String(SUPABASE_URL || '').trim();
    const key = String(SUPABASE_PUBLISHABLE_KEY || '').trim();
    const validUrl = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)
      || /^http:\/\/localhost(?::\d+)?$/i.test(url);
    const validKey = /^sb_publishable_[a-zA-Z0-9_-]+$/.test(key);
    return validUrl && validKey && !key.startsWith('sb_secret_');
  };

  const say = (text = '', kind = '') => {
    message.textContent = text;
    message.dataset.kind = kind;
  };

  const busyState = (value) => {
    busy = value;
    submit.disabled = value || !client;
    submit.textContent = value ? t('처리 중…', 'Please wait…') : labelForMode();
  };

  const labelForMode = () => ({
    signin: t('로그인', 'Sign in'),
    signup: t('회원가입', 'Create account'),
    forgot: t('재설정 이메일 보내기', 'Send reset email'),
    update: t('비밀번호 변경', 'Update password'),
  })[mode];

  const render = () => {
    const configured = Boolean(client);
    const signup = mode === 'signup';
    const forgot = mode === 'forgot';
    const update = mode === 'update';
    const passwordNeeded = !forgot;
    const tabsVisible = mode === 'signin' || signup;
    $('#authTabs').hidden = !configured || !tabsVisible;
    $('#authForm').hidden = !configured;
    $('#authLinks').hidden = !configured || mode === 'update';
    $('#authForgot').hidden = !tabsVisible || signup;
    $('#authModeSwitch').hidden = mode === 'update';
    $('#authConfirmField').hidden = !signup && !update;
    $('#authPasswordField').hidden = !passwordNeeded;
    $('#authPasswordLabel').textContent = update
      ? t('새 비밀번호', 'New password') : t('비밀번호', 'Password');
    $('#authPassword').autocomplete = update ? 'new-password' : 'current-password';
    $('#authPassword').required = passwordNeeded;
    $('#authConfirmPassword').required = signup || update;
    email.disabled = !client || busy;
    password.disabled = !client || busy;
    confirmPassword.disabled = !client || busy;
    $('#authSignInTab').setAttribute('aria-selected', String(mode === 'signin'));
    $('#authSignUpTab').setAttribute('aria-selected', String(signup));

    const heading = !configured ? [
      t('인증 서비스 연결이 필요합니다', 'Authentication setup required'),
      t('Supabase 프로젝트를 연결하면 이메일 가입과 로그인을 사용할 수 있습니다.', 'Connect a Supabase project to enable email sign-up and sign-in.'),
    ] : ({
      signin: [t('로그인', 'Sign in'), t('계정에 로그인해 문서 작업을 이어가세요.', 'Sign in to your account.')],
      signup: [t('새 계정 만들기', 'Create your account'), t('이메일로 계정을 만들고 확인 링크를 받으세요.', 'Create an account with your email and verify it.')],
      forgot: [t('비밀번호 재설정', 'Reset your password'), t('계정 이메일로 재설정 링크를 보냅니다.', 'We will send a reset link to your account email.')],
      update: [t('새 비밀번호 설정', 'Choose a new password'), t('새 비밀번호를 두 번 입력해 주세요.', 'Enter your new password twice.')],
    }[mode]);
    set('#authTitle', heading[0]);
    set('#authSubtitle', heading[1]);
    set('#authModeSwitch', signup || mode === 'forgot' ? t('로그인으로 돌아가기', 'Back to sign in') : t('회원가입', 'Create account'));
    submit.textContent = busy ? t('처리 중…', 'Please wait…') : labelForMode();
    submit.disabled = busy || !client;
    setupNotice.hidden = Boolean(client);
    $('#authConfigMessage').hidden = !client;
  };

  const setSession = (nextSession) => {
    session = nextSession;
    const changingPassword = Boolean(session) && mode === 'update';
    $('#authSignedOut').hidden = Boolean(session) && !changingPassword;
    $('#authAccount').hidden = !session || changingPassword;
    set('#authAccountEmail', session?.user?.email || '');
    const button = $('#authInfo');
    button.textContent = session?.user?.email || t('로그인 / 회원가입', 'Sign in / Sign up');
    button.title = session?.user?.email || '';
  };

  const resetForm = () => {
    form.reset();
    say();
  };
  const siteRedirectUrl = () => `${window.location.origin}${window.location.pathname}`;

  const switchMode = (nextMode) => {
    mode = nextMode;
    resetForm();
    render();
    const focusTarget = mode === 'update' ? password : email;
    if (!focusTarget.disabled) focusTarget.focus();
  };

  const errorText = (error) => {
    const code = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
    if (code.includes('invalid_login') || code.includes('invalid_credentials')) return t('이메일 또는 비밀번호를 확인해 주세요.', 'Check your email and password.');
    if (code.includes('email_not_confirmed')) return t('이메일 확인 링크를 먼저 눌러 주세요.', 'Confirm your email before signing in.');
    if (code.includes('already registered') || code.includes('user_already_exists')) return t('이미 가입된 이메일입니다. 로그인해 주세요.', 'This email is already registered. Please sign in.');
    if (code.includes('weak_password') || code.includes('password should')) return t('비밀번호 정책을 확인하고 더 안전한 비밀번호를 입력해 주세요.', 'Choose a stronger password that meets the project policy.');
    if (code.includes('rate limit') || code.includes('over_email_send_rate_limit')) return t('이메일 전송 한도에 도달했습니다. 잠시 뒤 다시 시도해 주세요.', 'The email sending limit was reached. Try again later.');
    if (code.includes('email_address_not_authorized')) return t('현재 Supabase 기본 메일은 프로젝트 팀 이메일로만 전송할 수 있습니다. 테스트 이메일을 사용하거나 SMTP를 설정해 주세요.', 'The default Supabase mailer only sends to project team addresses. Use a team email for testing or configure SMTP.');
    return t('요청을 처리하지 못했습니다. 연결 설정과 입력 내용을 확인한 뒤 다시 시도해 주세요.', 'The request failed. Check the connection settings and your input, then try again.');
  };

  $('#authInfo').addEventListener('click', () => dialog.showModal());
  $('#authClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  $('#authSignInTab').addEventListener('click', () => switchMode('signin'));
  $('#authSignUpTab').addEventListener('click', () => switchMode('signup'));
  $('#authModeSwitch').addEventListener('click', () => switchMode(mode === 'signup' ? 'signin' : 'signup'));
  $('#authForgot').addEventListener('click', () => switchMode('forgot'));

  $('#authSignOut').addEventListener('click', async () => {
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) say(errorText(error), 'error');
    else { setSession(null); switchMode('signin'); }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!client || busy) return;
    say();
    if (!email.checkValidity()) { email.reportValidity(); return; }
    if (mode === 'signup' || mode === 'update') {
      if (password.value.length < 8) {
        say(t('비밀번호는 8자 이상 입력해 주세요.', 'Use at least 8 characters for your password.'), 'error');
        password.focus();
        return;
      }
      if (password.value !== confirmPassword.value) {
        say(t('비밀번호가 서로 다릅니다.', 'The passwords do not match.'), 'error');
        confirmPassword.focus();
        return;
      }
    }

    busyState(true);
    try {
      let error;
      if (mode === 'signup') {
        const result = await client.auth.signUp({
          email: email.value.trim(),
          password: password.value,
          options: { emailRedirectTo: siteRedirectUrl() },
        });
        error = result.error;
        if (!error && result.data.session) {
          setSession(result.data.session);
          dialog.close();
        } else if (!error) {
          say(t('가입 요청을 받았습니다. 이메일 인증이 켜져 있으면 받은편지함에서 확인 링크를 눌러 주세요.', 'Sign-up submitted. If email confirmation is enabled, check your inbox for the verification link.'), 'success');
          form.reset();
        }
      } else if (mode === 'signin') {
        const result = await client.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
        error = result.error;
        if (!error) { setSession(result.data.session); dialog.close(); }
      } else if (mode === 'forgot') {
        const result = await client.auth.resetPasswordForEmail(email.value.trim(), {
          redirectTo: siteRedirectUrl(),
        });
        error = result.error;
        if (!error) say(t('요청이 처리되었습니다. 해당 이메일이 등록되어 있고 메일 전송이 허용되면 재설정 링크를 받게 됩니다.', 'The request was processed. If the address is registered and email delivery is allowed, a reset link will arrive.'), 'success');
      } else if (mode === 'update') {
        const result = await client.auth.updateUser({ password: password.value });
        error = result.error;
        if (!error) {
          mode = 'signin';
          setSession(session);
          dialog.close();
        }
      }
      if (error) say(errorText(error), 'error');
    } catch (error) {
      console.error('Authentication request failed.', error);
      say(errorText(error), 'error');
    } finally {
      busyState(false);
    }
  });

  const updateLanguage = () => {
    const selected = mode === 'signin' || mode === 'signup' ? mode : null;
    if (selected) render();
    if (session?.user?.email) set('#authInfo', session.user.email);
  };

  const boot = async () => {
    if (!hasValidConfig()) {
      render();
      return;
    }
    try {
      say(t('인증 서비스를 연결하는 중…', 'Connecting to authentication…'));
      const { createClient } = await import(SUPABASE_JS_CDN);
      client = createClient(SUPABASE_URL.trim(), SUPABASE_PUBLISHABLE_KEY.trim(), {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      client.auth.onAuthStateChange((event, nextSession) => {
        if (event === 'PASSWORD_RECOVERY') {
          mode = 'update';
          resetForm();
          setSession(nextSession);
          render();
          if (!dialog.open) dialog.showModal();
        } else {
          setSession(nextSession);
        }
      });
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      setSession(data.session);
      setupNotice.hidden = true;
      say();
      render();
    } catch (error) {
      console.error('Authentication initialization failed.', error);
      setupNotice.hidden = false;
      setupNotice.textContent = t('인증 모듈을 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 다시 열어 주세요.', 'Could not load the authentication module. Check the internet connection and reopen this page.');
      say(t('연결에 실패했습니다.', 'Connection failed.'), 'error');
      render();
    }
  };

  render();
  boot();
  return updateLanguage;
}
