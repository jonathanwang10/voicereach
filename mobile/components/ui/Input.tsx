import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TextInputProps,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../theme';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  helper?: string;
  leftIcon?: keyof typeof Ionicons.glyphMap;
  rightIcon?: keyof typeof Ionicons.glyphMap;
  onRightIconPress?: () => void;
  rightIconAccessibilityLabel?: string;
  variant?: 'outlined' | 'filled';
}

export const Input: React.FC<InputProps> = ({
  label,
  error,
  helper,
  leftIcon,
  rightIcon,
  onRightIconPress,
  rightIconAccessibilityLabel,
  variant = 'outlined',
  style,
  editable = true,
  onFocus,
  onBlur,
  ...props
}) => {
  const [isFocused, setIsFocused] = useState(false);

  const containerStyles = [
    styles.container,
    styles[variant],
    isFocused && styles.focused,
    error && styles.errorContainer,
    !editable && styles.disabled,
  ];

  const inputStyles = [
    styles.input,
    leftIcon && styles.inputWithLeftIcon,
    rightIcon && styles.inputWithRightIcon,
    style,
  ];

  return (
    <View>
      {label && <Text style={styles.label}>{label}</Text>}
      <View style={containerStyles}>
        {leftIcon && (
          <Ionicons
            name={leftIcon}
            size={20}
            color={error ? theme.colors.danger[600] : theme.colors.neutral[400]}
            style={styles.leftIcon}
          />
        )}
        {/* The caller's props first, so its onFocus/onBlur run alongside (not
            instead of) the focus styling (C-69) */}
        <TextInput
          placeholderTextColor={theme.colors.text.tertiary}
          {...props}
          style={inputStyles}
          onFocus={e => {
            setIsFocused(true);
            onFocus?.(e);
          }}
          onBlur={e => {
            setIsFocused(false);
            onBlur?.(e);
          }}
          editable={editable}
        />
        {rightIcon && (
          <TouchableOpacity
            onPress={onRightIconPress}
            disabled={!onRightIconPress}
            accessibilityRole="button"
            accessibilityLabel={rightIconAccessibilityLabel}
            accessibilityState={{ disabled: !onRightIconPress }}
            style={styles.rightIconButton}
          >
            <Ionicons
              name={rightIcon}
              size={20}
              color={error ? theme.colors.danger[600] : theme.colors.neutral[400]}
            />
          </TouchableOpacity>
        )}
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {helper && !error && <Text style={styles.helper}>{helper}</Text>}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing.base,
    minHeight: 48,
  },

  // Variants
  outlined: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  filled: {
    backgroundColor: theme.colors.neutral[50],
    borderWidth: 1,
    borderColor: 'transparent',
  },

  // States
  focused: {
    borderColor: theme.colors.primary[500],
    borderWidth: 2,
  },
  errorContainer: {
    borderColor: theme.colors.danger[500],
    borderWidth: 2,
  },
  disabled: {
    opacity: theme.opacity.disabled,
    backgroundColor: theme.colors.neutral[100],
  },

  // Input
  input: {
    flex: 1,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.primary,
    paddingVertical: theme.spacing.md,
  },
  inputWithLeftIcon: {
    paddingLeft: theme.spacing.sm,
  },
  inputWithRightIcon: {
    paddingRight: theme.spacing.sm,
  },

  // Label
  label: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.medium,
    color: theme.colors.text.primary,
    marginBottom: theme.spacing.xs,
  },

  // Helper texts
  error: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.danger[600],
    marginTop: theme.spacing.xs,
  },
  helper: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.text.secondary,
    marginTop: theme.spacing.xs,
  },

  // Icons
  leftIcon: {
    marginRight: theme.spacing.sm,
  },
  rightIconButton: {
    padding: theme.spacing.xs,
  },
});