export const detectIsMacOS = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return navigator.userAgent.toLowerCase().includes('mac');
};

export const isMacOS = detectIsMacOS();
