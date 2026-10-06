import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { theme } from '../../theme';

type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'secondary';
type BadgeSize = 'small' | 'medium' | 'large';

interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  style?: ViewStyle;
  dot?: boolean;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'default',
  size = 'medium',
  style,
  dot = false,
}) => {
  const badgeStyles = [
    styles.base,
    styles[variant],
    styles[`${size}Size`],
    dot && styles.dot,
    style,
  ];

  const textStyles = [
    styles.text,
    styles[`${variant}Text`],
    styles[`${size}Text`],
  ];

  if (dot) {
    return <View style={[badgeStyles, styles.dotStyle]} />;
  }

  return (
    <View style={badgeStyles}>
      <Text style={textStyles}>{children}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  base: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderRadius: theme.borderRadius.full,
    alignSelf: 'flex-start',
  },

  // Variants
  default: {
    backgroundColor: theme.colors.neutral[200],
  },
  primary: {
    backgroundColor: theme.colors.primary[100],
  },
  success: {
    backgroundColor: theme.colors.success[100],
  },
  warning: {
    backgroundColor: theme.colors.warning[100],
  },
  danger: {
    backgroundColor: theme.colors.danger[100],
  },
  info: {
    backgroundColor: theme.colors.primary[50],
  },
  secondary: {},

  // Text colors
  text: {
    fontWeight: theme.typography.fontWeight.semibold,
  },
  defaultText: {
    color: theme.colors.neutral[700],
  },
  primaryText: {
    color: theme.colors.primary[700],
  },
  successText: {
    color: theme.colors.success[700],
  },
  warningText: {
    color: theme.colors.warning[700],
  },
  dangerText: {
    color: theme.colors.danger[700],
  },
  infoText: {
    color: theme.colors.primary[600],
  },
  secondaryText: {},

  // Sizes
  smallSize: {
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: 2,
  },
  mediumSize: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
  },
  largeSize: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },

  // Text sizes
  smallText: {
    fontSize: theme.typography.fontSize.xs,
    lineHeight: theme.typography.fontSize.xs * 1.2,
  },
  mediumText: {
    fontSize: theme.typography.fontSize.sm,
    lineHeight: theme.typography.fontSize.sm * 1.2,
  },
  largeText: {
    fontSize: theme.typography.fontSize.base,
    lineHeight: theme.typography.fontSize.base * 1.2,
  },

  // Dot style
  dot: {
    padding: 0,
  },
  dotStyle: {
    width: 8,
    height: 8,
  },
});