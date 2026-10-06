import React from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  ViewStyle,
  StyleProp,
  TouchableOpacityProps,
} from 'react-native';
import { theme } from '../../theme';

interface CardProps extends Omit<TouchableOpacityProps, 'style'> {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  variant?: 'elevated' | 'outlined' | 'filled';
  padding?: 'none' | 'small' | 'medium' | 'large';
}

export const Card: React.FC<CardProps> = ({
  children,
  style,
  onPress,
  variant = 'elevated',
  padding = 'medium',
  ...props
}) => {
  const cardStyles = [
    styles.base,
    styles[variant],
    styles[`${padding}Padding`],
    style,
  ];

  if (onPress) {
    return (
      <TouchableOpacity
        style={cardStyles}
        onPress={onPress}
        activeOpacity={0.7}
        {...props}
      >
        {children}
      </TouchableOpacity>
    );
  }

  return <View style={cardStyles}>{children}</View>;
};

const styles = StyleSheet.create({
  base: {
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.lg,
    overflow: 'hidden',
  },

  // Variants
  elevated: {
    ...theme.shadows.card,
  },
  outlined: {
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  filled: {
    backgroundColor: theme.colors.surface,
  },

  // Padding
  nonePadding: {
    padding: 0,
  },
  smallPadding: {
    padding: theme.spacing.sm,
  },
  mediumPadding: {
    padding: theme.spacing.base,
  },
  largePadding: {
    padding: theme.spacing.lg,
  },
});