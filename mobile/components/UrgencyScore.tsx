import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Alert,
  TouchableOpacity,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { getUrgencyScoreColor, getDisplayUrgencyScore } from '../utils/urgencyScore';

interface UrgencyScoreProps {
  individual: {
    id: string;
    urgency_score: number;
    urgency_override?: number | null;
  };
  onOverrideChange: (value: number | null) => void;
  showSlider?: boolean; // Optional prop to show/hide slider
}

export default function UrgencyScore({
  individual,
  onOverrideChange,
  showSlider = false,
}: UrgencyScoreProps) {
  // State for the slider value
  const [sliderValue, setSliderValue] = useState<number>(0);

  // Get the display score (override or calculated)
  const displayScore = getDisplayUrgencyScore(individual);
  const scoreColor = getUrgencyScoreColor(displayScore);

  // Follow the shown score (override or calculated) whenever it changes
  useEffect(() => {
    setSliderValue(displayScore);
  }, [displayScore]);

  // Handle slider value change
  const handleSliderChange = (value: number) => {
    const roundedValue = Math.round(value)
    setSliderValue(roundedValue);
  };

  // Handle slider completion (when user stops dragging)
  const handleSliderComplete = (value: number) => {
    const newValue = Math.round(value); // Round to nearest integer
    
    // Show confirmation dialog for manual override
    Alert.alert(
      'Set Manual Override',
      `Set urgency score to ${newValue}?`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            setSliderValue(displayScore); // Reset to original value
          },
        },
        {
          text: 'Set Override',
          onPress: () => {
            onOverrideChange(newValue);
          },
        },
      ]
    );
  };

  // Handle clearing manual override
  const handleClearOverride = () => {
    Alert.alert(
      'Clear Manual Override',
      'Remove manual override and use calculated score?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Clear Override',
          onPress: () => {
            onOverrideChange(null);
            setSliderValue(individual.urgency_score);
          },
        },
      ]
    );
  };

  return (
    <View style={styles.container}>
      {/* Large Urgency Score Display */}
      <View style={[styles.scoreContainer, { backgroundColor: scoreColor }]}>
        <Text style={styles.scoreLabel}>Urgency Score</Text>
        <Text style={styles.scoreValue}>{displayScore}</Text>
        
        {/* Manual Override Indicator */}
        {individual.urgency_override != null && (
          <View style={styles.manualIndicator}>
            <Text style={styles.manualLabel}>Manual Override</Text>
            <TouchableOpacity onPress={handleClearOverride}>
              <Text style={styles.clearButton}>
                Clear
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Slider for Manual Override */}
      {showSlider && (
        <View style={styles.sliderContainer}>
          <View style={styles.sliderHeader}>
            <Text style={styles.sliderLabel}>Manual Override</Text>
            <Text style={styles.sliderValue}>{sliderValue}</Text>
          </View>
          
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            value={sliderValue}
            onValueChange={handleSliderChange}
            onSlidingComplete={handleSliderComplete}
            minimumTrackTintColor="#007AFF"
            maximumTrackTintColor="#E5E7EB"
          />
          
          <View style={styles.sliderRange}>
            <Text style={styles.rangeLabel}>Low Urgency</Text>
            <Text style={styles.rangeLabel}>High Urgency</Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    marginVertical: 16,
  },
  scoreContainer: {
    padding: 20,
    borderRadius: 16,
    alignItems: 'center',
    minWidth: 120,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  scoreLabel: {
    fontSize: 14,
    color: '#fff',
    opacity: 0.9,
    marginBottom: 8,
    fontWeight: '500',
  },
  scoreValue: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
  },
  manualIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  manualLabel: {
    fontSize: 12,
    color: '#fff',
    opacity: 0.8,
    marginRight: 8,
  },
  clearButton: {
    fontSize: 12,
    color: '#fff',
    textDecorationLine: 'underline',
    fontWeight: '500',
  },
  sliderContainer: {
    marginTop: 20,
    width: '100%',
    paddingHorizontal: 20,
  },
  sliderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  sliderLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#374151',
  },
  sliderValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#007AFF',
  },
  slider: {
    width: '100%',
    height: 40,
  },

  sliderRange: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  rangeLabel: {
    fontSize: 12,
    color: '#6B7280',
  },
});
