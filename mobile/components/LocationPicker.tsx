import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MapView, { Marker } from 'react-native-maps';
import * as Location from 'expo-location';
import { SF_DEFAULT_COORDINATE, UNKNOWN_ADDRESS, addressFor } from '../utils/location';

interface LocationPickerProps {
  onLocationSelected: (location: { 
    location: {
      latitude: number;
      longitude: number;
      address: string;
    }
  }) => void;
  onCancel: () => void;
  initialLocation?: { latitude: number; longitude: number };
}

export const LocationPicker: React.FC<LocationPickerProps> = ({
  onLocationSelected,
  onCancel,
  initialLocation,
}) => {
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(initialLocation || null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState<string>('');
  // Only the newest address lookup may set the address: an older one that
  // resolves late would pair the old address with the new pin
  const geocodeRequestRef = useRef(0);
  // The map is uncontrolled (H2-6.2): it opens at initialRegion and is moved with
  // animateToRegion, so a re-render never snaps it back while the worker pans
  const mapRef = useRef<MapView>(null);
  const [initialRegion, setInitialRegion] = useState<{ latitude: number; longitude: number } | null>(
    initialLocation || null
  );

  useEffect(() => {
    getCurrentLocation();
  }, []);

  useEffect(() => {
    if (!selectedLocation) return;
    mapRef.current?.animateToRegion({ ...selectedLocation, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 300);
  }, [selectedLocation]);

  // Start the pin at the location passed in, else the GPS fix, else the SF default.
  // A denied permission or a failed fix still opens the map (C-04).
  const getCurrentLocation = async () => {
    let fix: Location.LocationObject | null = null;
    try {
      setIsLoading(true);
      setError(null);

      // Request location permissions
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setError('Location permission denied');
      } else {
        fix = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
          timeInterval: 5000,
          distanceInterval: 10,
        });
        setLocation(fix);
      }
    } catch (err) {
      if (__DEV__) console.error('Error getting location:', err);
      setError('Failed to get current location');
    } finally {
      if (!initialLocation) {
        const start = fix
          ? { latitude: fix.coords.latitude, longitude: fix.coords.longitude }
          : SF_DEFAULT_COORDINATE;
        setSelectedLocation(start);
        setInitialRegion(start);
        updateAddress(start.latitude, start.longitude);
      }
      setIsLoading(false);
    }
  };

  const handleMapPress = (event: any) => {
    const { latitude, longitude } = event.nativeEvent.coordinate;
    setSelectedLocation({ latitude, longitude });
    updateAddress(latitude, longitude);
  };

  const handleMarkerDragEnd = (event: any) => {
    const { latitude, longitude } = event.nativeEvent.coordinate;
    setSelectedLocation({ latitude, longitude });
    updateAddress(latitude, longitude);
  };

  const updateAddress = async (latitude: number, longitude: number) => {
    const request = ++geocodeRequestRef.current;
    // Until the new lookup lands, Confirm geocodes the pin itself
    setAddress('');
    const next = await addressFor(latitude, longitude);
    if (request === geocodeRequestRef.current) setAddress(next);
  };

  const handleConfirmLocation = async () => {
    if (!selectedLocation) {
      Alert.alert('Error', 'Please select a location on the map');
      return;
    }

    // Use the current address or get a fresh one. Without an address the coordinates
    // still count (H2-6.2): they go as UNKNOWN_ADDRESS.
    let finalAddress = address;
    if (!finalAddress || finalAddress === UNKNOWN_ADDRESS) {
      finalAddress = await addressFor(selectedLocation.latitude, selectedLocation.longitude);
    }

    onLocationSelected({
      location: {
        latitude: selectedLocation.latitude,
        longitude: selectedLocation.longitude,
        address: finalAddress,
      }
    });
  };

  if (isLoading) {
    return (
      <Modal visible={true} transparent animationType="slide">
        <SafeAreaView style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Getting your location...</Text>
          </View>
        </SafeAreaView>
      </Modal>
    );
  }

  const mapStart = initialRegion || selectedLocation || SF_DEFAULT_COORDINATE;

  return (
    <Modal visible={true} animationType="slide">
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Select Location</Text>
          <Text style={styles.subtitle}>
            Tap and drag the pin to adjust the location
          </Text>
        </View>

        <MapView
          ref={mapRef}
          style={styles.map}
          initialRegion={{
            ...mapStart,
            latitudeDelta: 0.01,
            longitudeDelta: 0.01,
          }}
          onPress={handleMapPress}
          showsUserLocation={true}
          showsMyLocationButton={true}
        >
          {selectedLocation && (
            <Marker
              coordinate={selectedLocation}
              draggable={true}
              onDragEnd={handleMarkerDragEnd}
              pinColor="#007AFF"
            />
          )}
        </MapView>

        <View style={styles.infoContainer}>
          <Text style={styles.infoText}>
            📍 Current Location: {location ? 'Detected' : error || 'Not available'}
          </Text>
          <Text style={styles.infoText}>
            🎯 Selected: {selectedLocation ? 'Pin placed' : 'Tap map to place pin'}
          </Text>
          {selectedLocation && (
            <Text style={styles.coordinatesText}>
              Lat: {selectedLocation.latitude.toFixed(6)}, 
              Lng: {selectedLocation.longitude.toFixed(6)}
            </Text>
          )}
          {address && (
            <Text style={styles.addressText}>
              📍 Address: {address}
            </Text>
          )}
        </View>

        <View style={styles.buttonContainer}>
          <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[
              styles.confirmButton,
              !selectedLocation && styles.disabledButton
            ]} 
            onPress={handleConfirmLocation}
            disabled={!selectedLocation}
          >
            <Text style={styles.confirmButtonText}>Confirm Location</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e9ecef',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
  },
  map: {
    flex: 1,
  },
  infoContainer: {
    padding: 16,
    backgroundColor: '#f8f9fa',
    borderTopWidth: 1,
    borderTopColor: '#e9ecef',
  },
  infoText: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  coordinatesText: {
    fontSize: 12,
    color: '#999',
    fontFamily: 'monospace',
    marginTop: 8,
  },
  addressText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '500',
    marginTop: 8,
  },
  buttonContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    backgroundColor: '#6c757d',
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  confirmButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  confirmButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  disabledButton: {
    backgroundColor: '#ccc',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 24,
    margin: 20,
    alignItems: 'center',
    minWidth: 300,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#666',
  },
}); 