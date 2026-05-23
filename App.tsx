import React, { useEffect, useState } from 'react'
import {
  Linking,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import nodejs from 'nodejs-mobile-react-native'

type PodState =
  | { kind: 'booting' }
  | { kind: 'status'; message: string }
  | { kind: 'ready'; url: string; port: string }
  | { kind: 'error'; message: string }

export default function App() {
  const [state, setState] = useState<PodState>({ kind: 'booting' })

  useEffect(() => {
    nodejs.start('main.js')

    const onMessage = (raw: string) => {
      try {
        const msg = JSON.parse(raw)
        if (msg.type === 'ready') {
          setState({ kind: 'ready', url: msg.url, port: msg.port })
        } else if (msg.type === 'status') {
          // Only show pre-ready status — once the pod is up, late status
          // messages (e.g. bootstrap progress) shouldn't clobber the URL.
          setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'status', message: msg.message }))
        } else if (msg.type === 'error') {
          setState({ kind: 'error', message: msg.message })
        }
      } catch {
        // ignore non-JSON traffic
      }
    }

    nodejs.channel.addListener('message', onMessage)
    return () => {
      nodejs.channel.removeListener('message', onMessage)
    }
  }, [])

  const openInBrowser = () => {
    if (state.kind === 'ready') {
      Linking.openURL(state.url)
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0b0d12" />
      <View style={styles.center}>
        <Text style={styles.brand}>Solid Pod</Text>
        <Text style={styles.sub}>jspod + JSS, on your phone</Text>

        {state.kind === 'booting' && (
          <Text style={styles.status}>Starting Node runtime…</Text>
        )}

        {state.kind === 'status' && (
          <Text style={styles.status}>{state.message}</Text>
        )}

        {state.kind === 'ready' && (
          <>
            <Text style={styles.status}>Pod running at</Text>
            <Text style={styles.url}>{state.url}</Text>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              onPress={openInBrowser}
            >
              <Text style={styles.buttonText}>Open in browser</Text>
            </Pressable>
            <Text style={styles.foot}>
              Sign in as <Text style={styles.mono}>me</Text> /{' '}
              <Text style={styles.mono}>me</Text>. Localhost-only.
            </Text>
          </>
        )}

        {state.kind === 'error' && (
          <>
            <Text style={styles.errorTitle}>Pod failed to start</Text>
            <Text style={styles.errorBody}>{state.message}</Text>
          </>
        )}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0d12' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  brand: { color: '#e7e9ee', fontSize: 36, fontWeight: '700', letterSpacing: 0.5 },
  sub: { color: '#8a90a0', fontSize: 14, marginTop: 6, marginBottom: 48 },
  status: { color: '#a8b0c2', fontSize: 16, marginVertical: 6 },
  url: { color: '#7aa2f7', fontSize: 18, fontFamily: 'monospace', marginBottom: 32 },
  button: {
    backgroundColor: '#7aa2f7',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 10,
  },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: '#0b0d12', fontWeight: '700', fontSize: 16 },
  foot: { color: '#6b7280', fontSize: 12, marginTop: 32, textAlign: 'center' },
  mono: { fontFamily: 'monospace', color: '#a8b0c2' },
  errorTitle: { color: '#f87171', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  errorBody: { color: '#a8b0c2', fontSize: 12, fontFamily: 'monospace', textAlign: 'center' },
})
