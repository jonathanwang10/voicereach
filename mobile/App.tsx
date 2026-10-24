import React, { useEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator, CardStyleInterpolators } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, ActivityIndicator, TouchableOpacity } from 'react-native';
import Toast from 'react-native-toast-message';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { CategoryProvider } from './contexts/CategoryContext';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient, wireQueryManagers } from './services/queryClient';
import { ErrorBoundary } from './components/ErrorBoundary';

// Import screens
import { ModernRecordScreen } from './screens/ModernRecordScreen';
import { ModernSearchScreen } from './screens/ModernSearchScreen';
import { ModernIndividualProfileScreen } from './screens/ModernIndividualProfileScreen';
import { ModernVoiceAssistantScreen } from './screens/ModernVoiceAssistantScreen';
import CategoriesScreen from './screens/CategoriesScreen';
import UserProfileScreen from './screens/UserProfileScreen';

const Tab = createBottomTabNavigator();
const Stack = createStackNavigator();

// Stack navigator for Search tab
function SearchStack() {
  return (
    <Stack.Navigator
      screenOptions={{
        cardStyleInterpolator: CardStyleInterpolators.forHorizontalIOS,
        gestureEnabled: true,
        gestureDirection: 'horizontal',
        transitionSpec: {
          open: {
            animation: 'timing',
            config: {
              duration: 300,
            },
          },
          close: {
            animation: 'timing',
            config: {
              duration: 250,
            },
          },
        },
      }}
    >
      <Stack.Screen
        name="SearchMain"
        component={ModernSearchScreen}
        options={{ title: 'Search' }}
      />
      <Stack.Screen
        name="IndividualProfile"
        component={ModernIndividualProfileScreen}
        options={{
          title: 'Individual Profile',
          cardStyleInterpolator: CardStyleInterpolators.forModalPresentationIOS,
        }}
      />
    </Stack.Navigator>
  );
}

function AppContent() {
  const { user, loading, error, retry } = useAuth();

  // Refetch on foreground and on reconnect (H2-6.6)
  useEffect(() => wireQueryManagers(), []);
  // Signed out: no person from this session may come back from the memory cache
  useEffect(() => {
    if (!user) queryClient.clear();
  }, [user]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  // No user: the sign-in failed, or the worker signed out (C-35, OD-4). Nothing
  // below mounts, so no screen fails on its own or signs in behind the worker's back.
  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{error ? "Can't sign in" : 'Signed out'}</Text>
        <Text style={styles.subtitle}>
          {error
            ? `${error}\n\nCheck your connection, and that the demo user exists in Supabase (see the README setup).`
            : 'The app signs in again automatically the next time it starts.'}
        </Text>
        <TouchableOpacity onPress={retry} accessibilityRole="button">
          <Text style={styles.retryText}>{error ? 'Retry' : 'Sign In'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Categories load only once signed in (no race with the sign-in)
  return (
    <CategoryProvider>
      <NavigationContainer>
        <Tab.Navigator
          initialRouteName="Record"
          screenOptions={({ route }) => ({
            tabBarIcon: ({ focused, color, size }) => {
              let iconName: keyof typeof Ionicons.glyphMap;

              if (route.name === 'Record') {
                iconName = focused ? 'camera' : 'camera-outline';
              } else if (route.name === 'Search') {
                iconName = focused ? 'search' : 'search-outline';
              } else if (route.name === 'VoiceAssistant') {
                iconName = focused ? 'mic' : 'mic-outline';
              } else if (route.name === 'Categories') {
                iconName = focused ? 'settings' : 'settings-outline';
              } else if (route.name === 'Profile') {
                iconName = focused ? 'person' : 'person-outline';
              } else {
                iconName = 'help-outline';
              }

              return <Ionicons name={iconName} size={size} color={color} />;
            },
            tabBarActiveTintColor: '#007AFF',
            tabBarInactiveTintColor: 'gray',
            headerShown: true,
          })}
        >
          <Tab.Screen
            name="Record"
            component={ModernRecordScreen}
            options={{ title: 'Record' }}
          />
          <Tab.Screen
            name="Search"
            component={SearchStack}
            options={{ title: 'Search', headerShown: false }}
          />
          <Tab.Screen
            name="VoiceAssistant"
            component={ModernVoiceAssistantScreen}
            options={{ title: 'Assistant' }}
          />
          <Tab.Screen 
            name="Categories" 
            component={CategoriesScreen}
            options={{ title: 'Categories' }}
          />
          <Tab.Screen 
            name="Profile" 
            component={UserProfileScreen}
            options={{ title: 'Profile' }}
          />
        </Tab.Navigator>
        <StatusBar style="auto" />
      </NavigationContainer>
    </CategoryProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary onReset={() => queryClient.clear()}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AppContent />
          <Toast />
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 20,
    textAlign: 'center',
  },
  loadingText: {
    marginTop: 10,
    fontSize: 16,
    color: '#666',
  },
  retryText: {
    marginTop: 20,
    color: '#007AFF',
    fontSize: 16,
    textDecorationLine: 'underline',
  },
});
