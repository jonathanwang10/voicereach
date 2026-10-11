import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import { IndividualProfile } from '../types';
import { SF_DEFAULT_COORDINATE } from '../utils/location';

interface IndividualLocationMapProps {
  profile: IndividualProfile;
  showTitle?: boolean;
}

const isCoordinate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export default function IndividualLocationMap({ profile, showTitle = true }: IndividualLocationMapProps) {
  // The person's own last location (C-03); no pin when there is none
  const lastLocation = profile.last_location;
  const coordinate =
    lastLocation && isCoordinate(lastLocation.latitude) && isCoordinate(lastLocation.longitude)
      ? { latitude: lastLocation.latitude, longitude: lastLocation.longitude }
      : null;
  const address = lastLocation?.address || null;
  const coordinatesLabel = coordinate ? `${coordinate.latitude}, ${coordinate.longitude}` : null;

  // Uncontrolled, so panning doesn't fight the prop; remounts when the location changes
  const initialRegion: Region = coordinate
    ? { ...coordinate, latitudeDelta: 0.004, longitudeDelta: 0.004 }
    : { ...SF_DEFAULT_COORDINATE, latitudeDelta: 0.05, longitudeDelta: 0.05 };

  const handleMarkerPress = () => {
    const message = address
      ? `${profile.name} was last seen at:\n${address}`
      : `Coordinates:\n${coordinatesLabel}`;
    Alert.alert('Selected Location', message, [{ text: 'OK' }]);
  };

  const formatLocationText = () => {
    if (!address) {
      return coordinatesLabel ?? 'Not recorded';
    }

    // Extract just the street address and city for display
    const parts = address.split(' ');
    if (parts.length > 3) {
      return parts.slice(0, 3).join(' ') + '...';
    }
    return address;
  };

  return (
    <View style={styles.container}>
      {showTitle && <Text style={styles.title}>Last Known Location</Text>}
      
      <View style={styles.mapContainer}>
        <MapView
          key={coordinatesLabel ?? 'none'}
          style={styles.map}
          initialRegion={initialRegion}
          showsUserLocation={false}
          showsMyLocationButton={false}
          scrollEnabled={true}
          zoomEnabled={true}
          pitchEnabled={false}
          rotateEnabled={false}
        >
          {coordinate && (
            <Marker
              coordinate={coordinate}
              title={profile.name}
              description={address || coordinatesLabel || undefined}
              onPress={handleMarkerPress}
            >
              <View style={styles.markerContainer}>
                <View style={styles.marker}>
                  <Text style={styles.markerText}>👤</Text>
                </View>
              </View>
            </Marker>
          )}
        </MapView>
        
        <View style={styles.addressContainer}>
          <Text style={styles.addressLabel}>Address:</Text>
          <Text style={styles.addressText}>{formatLocationText()}</Text>
          {!coordinate && !address && (
            <Text style={styles.noLocationSubtext}>
              No stored location for this individual.
            </Text>
          )}
          {coordinatesLabel && (
            <>
              <Text style={[styles.addressLabel, { marginTop: 12 }]}>Coordinates:</Text>
              <Text style={styles.addressText}>{coordinatesLabel}</Text>
            </>
          )}
          {coordinate && (
            <TouchableOpacity
              style={styles.fullAddressButton}
              onPress={() => Alert.alert(
                'Full Address',
                address || `Coordinates:\n${coordinatesLabel}`
              )}
            >
              <Text style={styles.fullAddressButtonText}>View Full Address</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1F2937',
    marginBottom: 12,
    letterSpacing: -0.2,
  },
  mapContainer: {
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  map: {
    height: 200,
    width: '100%',
  },
  markerContainer: {
    alignItems: 'center',
  },
  marker: {
    backgroundColor: '#007AFF',
    borderRadius: 20,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 5,
  },
  markerText: {
    fontSize: 16,
  },
  addressContainer: {
    padding: 16,
    backgroundColor: '#F8FAFC',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
  },
  addressLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748B',
    marginBottom: 4,
  },
  addressText: {
    fontSize: 16,
    color: '#1F2937',
    marginBottom: 8,
  },
  fullAddressButton: {
    alignSelf: 'flex-start',
  },
  fullAddressButtonText: {
    fontSize: 14,
    color: '#007AFF',
    fontWeight: '500',
  },
  noLocationSubtext: {
    fontSize: 14,
    color: '#94A3B8',
    textAlign: 'center',
  },
});
