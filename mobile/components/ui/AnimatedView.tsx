import React, { useEffect, useRef } from 'react';
import { Animated, Easing, ViewStyle } from 'react-native';

interface FadeInViewProps {
  children: React.ReactNode;
  duration?: number;
  delay?: number;
  style?: ViewStyle;
}

// Fades its children in once, after `delay` ms. (The only animation the app uses;
// the unused animation helpers and views were removed: C-69.)
export const FadeInView: React.FC<FadeInViewProps> = ({ children, duration = 400, delay = 0, style }) => {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    const timer = setTimeout(() => animation.start(), delay);
    return () => {
      clearTimeout(timer);
      animation.stop();
    };
  }, [duration, delay]);

  return <Animated.View style={[{ opacity }, style]}>{children}</Animated.View>;
};
