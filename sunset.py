import os
import time
from datetime import datetime, timedelta, timezone
import openmeteo_requests
import requests
import pandas as pd
import requests_cache
from retry_requests import retry
import smtplib
from email.mime.text import MIMEText

APP_PASSWORD = os.environ.get("APP_PASSWORD") 
RECIP_EMAIL = os.environ.get("RECIP_EMAIL")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL")


LAT = "36.077"
LON = "-75.80"
URL = f"https://api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}&daily=sunset&timezone=auto"

try:
    response = requests.get(URL).json()
    sunset_str = response['daily']['sunset'][0]  # e.g., "2026-05-22T20:15"
    
    #Convert the sunset string into an actual datetime object
    sunset_dt = datetime.fromisoformat(sunset_str)
    sunset_timestamp = pd.to_datetime(sunset_str, utc=True).tz_convert("America/New_York")
    print(f"Sunset time today is at {sunset_dt.strftime('%I:%M %p')}" )
    # Subtract 15 minutes from the sunset time
    target_text_time = sunset_dt - timedelta(minutes=15)
    print(f"Target text time is at {target_text_time.strftime('%I:%M %p')}")
    # Calculate how long the script needs to wait from right now
    now = datetime.now()
    wait_seconds = (target_text_time - now).total_seconds()
    print(f"Current time is {now.strftime('%I:%M %p')}")

    if wait_seconds > 0:
        print(f"Waiting {wait_seconds / 60:.1f} minutes to send text at {target_text_time.strftime('%I:%M %p')}...")
        time.sleep(wait_seconds)
    else:
        print("It is already past the 15-minute window for today, sending text immediately!")

    # Setup the Open-Meteo API client with cache and retry on error
    cache_session = requests_cache.CachedSession('.cache', expire_after = 3600)
    retry_session = retry(cache_session, retries = 5, backoff_factor = 0.2)
    openmeteo = openmeteo_requests.Client(session = retry_session)

    # Make sure all required weather variables are listed here
    # The order of variables in hourly or daily is important to assign them correctly below
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": 36.077192184101,
        "longitude": -75.80591489085553,
        "hourly": ["temperature_2m", "cloud_cover","cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "rain", "visibility"],
        "timezone": "America/New_York",
        "forecast_days": 1,
        "wind_speed_unit": "mph",
        "temperature_unit": "fahrenheit",
        "precipitation_unit": "inch",
    }
    responses = openmeteo.weather_api(url, params = params)

    # Process first location. Add a for-loop for multiple locations or weather models
    response = responses[0]
    print(f"Coordinates: {response.Latitude()}°N {response.Longitude()}°E")
    print(f"Elevation: {response.Elevation()} m asl")
    print(f"Timezone: {response.Timezone()}{response.TimezoneAbbreviation()}")
    print(f"Timezone difference to GMT+0: {response.UtcOffsetSeconds()}s")

    # Process hourly data. The order of variables needs to be the same as requested.
    hourly = response.Hourly()
    hourly_temperature_2m = hourly.Variables(0).ValuesAsNumpy()
    hourly_cloud_cover = hourly.Variables(1).ValuesAsNumpy()
    hourly_cloud_cover_low = hourly.Variables(2).ValuesAsNumpy()
    hourly_cloud_cover_mid = hourly.Variables(3).ValuesAsNumpy()
    hourly_cloud_cover_high = hourly.Variables(4).ValuesAsNumpy()
    hourly_rain = hourly.Variables(5).ValuesAsNumpy()
    hourly_visibility = hourly.Variables(6).ValuesAsNumpy()

    hourly_data = {
        "date": pd.date_range(
            start = pd.to_datetime(hourly.Time(), unit = "s", utc = True),
            end =  pd.to_datetime(hourly.TimeEnd(), unit = "s", utc = True),
            freq = pd.Timedelta(seconds = hourly.Interval()),
            inclusive = "left"
        ).tz_convert(response.Timezone().decode())
    }

    hourly_data["temperature_2m"] = hourly_temperature_2m
    hourly_data["cloud_cover"] = hourly_cloud_cover
    hourly_data["cloud_cover_low"] = hourly_cloud_cover_low
    hourly_data["cloud_cover_mid"] = hourly_cloud_cover_mid
    hourly_data["cloud_cover_high"] = hourly_cloud_cover_high
    hourly_data["rain"] = hourly_rain
    hourly_data["visibility"] = hourly_visibility
    #full hourly dataframe
    hourly_dataframe = pd.DataFrame(data = hourly_data)
    #print("\nHourly data\n", hourly_dataframe)
    
    start_time = sunset_timestamp - timedelta(minutes = 30)
    end_window = sunset_timestamp + timedelta(minutes = 30)
    sunset_profile_df = hourly_dataframe[(hourly_dataframe['date'] >= start_time) & (hourly_dataframe['date'] <= end_window)]

    # Grab the mean metrics inside our sunset window frame
    temp = sunset_profile_df['temperature_2m'].mean()
    total_clouds = sunset_profile_df['cloud_cover'].mean()
    low_clouds = sunset_profile_df['cloud_cover_low'].mean()
    high_clouds = sunset_profile_df['cloud_cover_high'].mean()
    rain = sunset_profile_df['rain'].mean()

    # Conditions text lines
    if rain > 0.01 and rain <= 0.1:
        condition = "Looks like it might be drizzling, could get a rainbow if the sun peeks through! 🌈"
    elif rain > 0.1:
        condition = "Light rain expected, but it could hold off long enough for a nice sunset! ☔"
    elif low_clouds > 70:
        condition = "Thick low clouds might block the horizon today but you never know if the sun might dip below! ☁️"
    elif low_clouds < 10 and total_clouds > 50:
        condition = "High clouds with a clear horizon could create a fiery red and orange sunset! 🔥"
    elif high_clouds > 40 and low_clouds < 20:
        condition = "Stunning potential! High cirrus clouds are rolling in—get ready for brilliant pinks and deep purples! 🎨🌅"
    elif total_clouds < 10:
        condition = "Clear and pristine skies. Perfect for a classic, glowing sunset. ☀️"
    else:
        condition = f"Scattered clouds ({total_clouds:.0f}% coverage). Could provide some great contrast!"

    message_body = (
        f"Hi Mom! Today's sunset is at {sunset_dt.strftime('%I:%M %p')}.\n\n"
        f"{condition}\n"
        f"Temp: {temp:.1f}°F"
    )

    # 2. Package your existing message_body
    msg = MIMEText(message_body)
    msg['From'] = SENDER_EMAIL
    msg['To'] = RECIP_EMAIL

    # 3. Fire it through a standard SMTP mail server
    try:
        server = smtplib.SMTP("smtp.gmail.com", 587)
        server.starttls()
        # Use a secure App Password generated in your Gmail settings
        server.login(SENDER_EMAIL, APP_PASSWORD) 
        server.sendmail(msg['From'], msg['To'], msg.as_string())
        server.quit()
        print("Text instantly delivered to her phone via carrier gateway!")
    except Exception as e:
        print(f"Email gateway delivery failed: {e}")


except Exception as e:
    print(f"Error: {e}")
