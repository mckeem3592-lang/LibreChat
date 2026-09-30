export const selectMacBuiltInMicrophone = (devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined =>
  devices.find(
    (device) =>
      device.kind === 'audioinput' &&
      /^(?:Default - )?(?:MacBook (?:Air|Pro) Microphone(?: \(Built-in\))?|Built-in Microphone)$/i.test(
        device.label,
      ),
  );

export const openMacBuiltInMicrophone = async (
  mediaDevices: Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'>,
): Promise<MediaStream> => {
  const microphone = selectMacBuiltInMicrophone(await mediaDevices.enumerateDevices());
  if (!microphone) {
    throw new Error('MacBook microphone unavailable');
  }
  return mediaDevices.getUserMedia({
    audio: { deviceId: { exact: microphone.deviceId } },
    video: false,
  });
};
