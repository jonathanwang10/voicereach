export const buildCategoryPayload = (form: {
  name: string;
  type: string;
  priority: string;
  options: any[];
  dangerWeight: number | string;
  autoTrigger: boolean;
}) => {
  // Only number and single_select categories may carry an urgency weight.
  const weighted = form.type === 'number' || form.type === 'single_select';
  return {
    name: form.name.trim(),
    type: form.type,
    is_required: false,
    priority: form.priority,
    urgency_weight: weighted ? Number(form.dangerWeight) || 0 : 0,
    auto_trigger: weighted ? form.autoTrigger : false,
    options: (form.type === 'single_select' || form.type === 'multi_select') ? form.options : null,
  };
};
