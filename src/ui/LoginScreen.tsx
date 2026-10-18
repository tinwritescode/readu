import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { requestLoginCode, verifyLoginCode } from '../adapters/speech/backend';
import { colors, fonts } from './theme';

interface Props {
  onLoggedIn: (token: string) => void;
}

/** Two steps: an email gets a six-digit code, and the code gets a session token. */
export function LoginScreen({ onLoggedIn }: Props) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    const address = email.trim().toLowerCase();
    setBusy(true);
    setError(null);
    try {
      await requestLoginCode(address);
      setSentTo(address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const logIn = async () => {
    if (!sentTo) return;
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await verifyLoginCode(sentTo, code.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.box}>
        <Text style={styles.title}>vTTS Reader</Text>
        <Text style={styles.lead}>
          {sentTo
            ? `Enter the 6-digit code sent to ${sentTo}. It lasts 10 minutes.`
            : 'Log in with your email. We will send you a code.'}
        </Text>

        {sentTo ? (
          <TextInput
            testID="code-input"
            style={styles.input}
            value={code}
            onChangeText={text => setCode(text.replace(/\D/g, '').slice(0, 6))}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoFocus
            placeholder="123456"
            placeholderTextColor={colors.muted}
          />
        ) : (
          <TextInput
            testID="email-input"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            placeholder="you@example.com"
            placeholderTextColor={colors.muted}
          />
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          testID={sentTo ? 'login-submit' : 'send-code'}
          disabled={busy || (sentTo ? code.length !== 6 : !email.includes('@'))}
          style={({ pressed }) => [
            styles.button,
            (busy || (sentTo ? code.length !== 6 : !email.includes('@'))) && styles.disabled,
            pressed && styles.pressed,
          ]}
          onPress={sentTo ? logIn : sendCode}>
          {busy ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={styles.buttonText}>{sentTo ? 'Log in' : 'Send code'}</Text>
          )}
        </Pressable>

        {sentTo ? (
          <Pressable
            style={styles.link}
            onPress={() => {
              setSentTo(null);
              setCode('');
              setError(null);
            }}>
            <Text style={styles.linkText}>Use another email</Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  box: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, gap: 14 },
  title: { fontFamily: fonts.readMedium, fontSize: 30, color: colors.text },
  lead: { fontSize: 15, lineHeight: 22, color: colors.muted, marginBottom: 6 },
  input: {
    height: 52,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: 17,
    color: colors.text,
  },
  error: { color: colors.danger, fontSize: 14 },
  button: {
    height: 52,
    borderRadius: 14,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '700', color: colors.onAccent },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  link: { alignItems: 'center', paddingVertical: 8 },
  linkText: { fontSize: 15, color: colors.accent },
});
